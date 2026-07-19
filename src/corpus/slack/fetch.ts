/**
 * The impure Slack edge. Discovers every channel the token can read (`conversations.list`, paged),
 * then pages each channel's `conversations.history` over the window and every thread's
 * `conversations.replies`, shaping raw payloads defensively into the clean items `project.ts` consumes.
 * The `@slack/web-api` `WebClient` is confined here behind an injected `SlackApi` seam so the whole
 * orchestration is unit-testable with a fake. Permalinks are constructed from the workspace URL + ts
 * (Slack's stable `archives/<channel>/p<ts>` form) rather than an extra call per message. File/image
 * attachments are kept as REFS only — never bytes, never a private download URL.
 */
import { WebClient } from "@slack/web-api";

import { isRecord } from "../../lib/parsers.js";
import { retryTransient } from "../../lib/resilience.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import type { ExportWindow } from "../types.js";
import type {
  SlackAttachmentRef,
  SlackChannelItems,
  SlackMessageItem,
  SlackNameMaps,
  SlackReplyItem,
} from "./project.js";
import { latestReplyTs, newerReplies, type ThreadCursors, threadKey } from "./threadCursors.js";

const PAGE_LIMIT = 200;

/**
 * Choose the token to READ Slack with: a user token (full channel visibility) wins; a bot token is the
 * fallback but only sees bot-invited channels, so it comes with a limited-breadth warning. Pure — the
 * env/file lookups happen in the caller, so the precedence + warning are unit-testable.
 *
 * @param userToken the resolved Slack user token, if any
 * @param botToken the resolved Slack bot token, if any
 * @returns the read token (absent ⇒ neither configured) + a warning when falling back to the bot token
 */
export function resolveSlackReadToken({
  userToken,
  botToken,
}: {
  userToken: string | undefined;
  botToken: string | undefined;
}): { token?: string; warning?: string } {
  if (userToken !== undefined) {
    return { token: userToken };
  }
  if (botToken !== undefined) {
    return {
      token: botToken,
      warning:
        "slack: using a bot token — channel visibility is limited to bot-invited channels; set SLACK_USER_TOKEN for full read access",
    };
  }
  return {};
}

/** A page of channels from `conversations.list`. */
export interface SlackChannelsPage {
  readonly channels: readonly unknown[];
  readonly nextCursor?: string;
}

/** A page of messages from `conversations.history`/`.replies`. */
export interface SlackMessagesPage {
  readonly messages: readonly unknown[];
  readonly nextCursor?: string;
}

/** A page of workspace members from `users.list`. */
export interface SlackUsersPage {
  readonly members: readonly unknown[];
  readonly nextCursor?: string;
}

/** Injected Slack seam. Raw shapes stay `unknown`; the fetch parses them defensively. */
export interface SlackApi {
  workspaceUrl: () => Promise<string | undefined>;
  listChannels: (args: { cursor?: string }) => Promise<SlackChannelsPage>;
  listUsers: (args: { cursor?: string }) => Promise<SlackUsersPage>;
  history: (args: { channel: string; oldest: string; latest: string; cursor?: string }) => Promise<SlackMessagesPage>;
  replies: (args: { channel: string; ts: string; oldest: string; cursor?: string }) => Promise<SlackMessagesPage>;
}

/** Coerce an unknown to a non-empty string, or undefined. */
function optStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Slack decimal ts (`epochSeconds.micros`) → ISO-8601. Empty when unparseable. */
function tsToIso({ ts }: { ts: string }): string {
  const seconds = Number(ts.split(".")[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : "";
}

/** A `YYYY-MM-DD` window bound → Slack epoch-seconds string (`oldest`/`latest` share this shape). */
function dateToEpoch({ date, fallback }: { date: string; fallback: string }): string {
  const ms = Date.parse(`${date}T00:00:00Z`);
  return Number.isFinite(ms) ? String(Math.floor(ms / 1000)) : fallback;
}

/** Construct the stable Slack permalink for a message (no per-message API call). */
function permalinkFor({
  workspaceUrl,
  channelId,
  ts,
}: {
  workspaceUrl: string;
  channelId: string;
  ts: string;
}): string {
  const base = workspaceUrl.endsWith("/") ? workspaceUrl : `${workspaceUrl}/`;
  return `${base}archives/${channelId}/p${ts.replace(".", "")}`;
}

/** Defensively shape a raw file object into an attachment ref (id is required). */
function shapeFile({ raw }: { raw: unknown }): SlackAttachmentRef | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = optStr({ value: raw["id"] });
  if (id === undefined) {
    return undefined;
  }
  const name = optStr({ value: raw["name"] });
  const title = optStr({ value: raw["title"] });
  const mimetype = optStr({ value: raw["mimetype"] });
  const altText = optStr({ value: raw["alt_txt"] });
  const permalink = optStr({ value: raw["permalink"] });
  const user = optStr({ value: raw["user"] });
  return {
    id,
    ...(name !== undefined ? { name } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(mimetype !== undefined ? { mimetype } : {}),
    ...(altText !== undefined ? { altText } : {}),
    ...(user !== undefined ? { user } : {}),
    ...(permalink !== undefined ? { permalink } : {}),
    raw,
  };
}

/** Reaction names + counts as `:name: xN` strings. */
function shapeReactions({ raw }: { raw: unknown }): readonly string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of raw) {
    if (isRecord(entry)) {
      const name = optStr({ value: entry["name"] });
      const count = typeof entry["count"] === "number" ? entry["count"] : 1;
      if (name !== undefined) {
        out.push(`:${name}: x${String(count)}`);
      }
    }
  }
  return out;
}

/** Common message fields shared by top-level messages and replies (author omitted when absent). */
function shapeCommon({
  raw,
  workspaceUrl,
  channelId,
}: {
  raw: Record<string, unknown>;
  workspaceUrl: string;
  channelId: string;
}):
  | {
      ts: string;
      tsIso: string;
      text?: string;
      author?: string;
      permalink: string;
      files: readonly SlackAttachmentRef[];
      raw: Readonly<Record<string, unknown>>;
    }
  | undefined {
  const ts = optStr({ value: raw["ts"] });
  if (ts === undefined) {
    return undefined;
  }
  const author = optStr({ value: raw["user"] });
  const text = optStr({ value: raw["text"] });
  const files = Array.isArray(raw["files"])
    ? raw["files"]
        .map((file) => shapeFile({ raw: file }))
        .filter((file): file is SlackAttachmentRef => file !== undefined)
    : [];
  return {
    files,
    permalink: permalinkFor({ channelId, ts, workspaceUrl }),
    raw,
    ts,
    tsIso: tsToIso({ ts }),
    ...(author !== undefined ? { author } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

/** Common context threaded through the page-shaping cores (the channel + workspace a page belongs to). */
interface ChannelContext {
  readonly workspaceUrl: string;
  readonly channelId: string;
  readonly channelName: string | undefined;
}

/**
 * Shape one `conversations.history` page's raw messages into message items (reactions + files resolved).
 * Pure + defensive — a non-object or ts-less row is dropped, never fatal.
 *
 * @param messages the raw page messages
 * @param ctx the channel context (workspace url, channel id/name)
 * @returns the shaped message items
 */
export function shapeHistoryPage({
  messages,
  ctx,
}: {
  messages: readonly unknown[];
  ctx: ChannelContext;
}): readonly SlackMessageItem[] {
  const items: SlackMessageItem[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) {
      continue;
    }
    const common = shapeCommon({ channelId: ctx.channelId, raw, workspaceUrl: ctx.workspaceUrl });
    if (common === undefined) {
      continue;
    }
    items.push({
      channelId: ctx.channelId,
      reactions: shapeReactions({ raw: raw["reactions"] }),
      ...common,
      ...(ctx.channelName !== undefined ? { channelName: ctx.channelName } : {}),
    });
  }
  return items;
}

/**
 * The thread parents worth polling from a history page — those with a positive `reply_count`. Pure, so
 * the "which threads to re-read" decision is unit-tested apart from the paging IO.
 *
 * @param messages the raw page messages
 * @returns the thread timestamps to poll
 */
export function planThreadPolls({ messages }: { messages: readonly unknown[] }): readonly { threadTs: string }[] {
  const polls: { threadTs: string }[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) {
      continue;
    }
    const ts = optStr({ value: raw["ts"] });
    const replyCount = typeof raw["reply_count"] === "number" ? raw["reply_count"] : 0;
    if (ts !== undefined && replyCount > 0) {
      polls.push({ threadTs: ts });
    }
  }
  return polls;
}

/**
 * Shape one `conversations.replies` page into reply items, skipping the parent (captured as the top-level
 * message). Pure + defensive.
 *
 * @param messages the raw page messages
 * @param ctx the channel context
 * @param threadTs the parent thread ts (whose echo is skipped)
 * @returns the shaped reply items
 */
export function shapeRepliesPage({
  messages,
  ctx,
  threadTs,
}: {
  messages: readonly unknown[];
  ctx: ChannelContext;
  threadTs: string;
}): readonly SlackReplyItem[] {
  const replies: SlackReplyItem[] = [];
  for (const raw of messages) {
    if (!isRecord(raw)) {
      continue;
    }
    const common = shapeCommon({ channelId: ctx.channelId, raw, workspaceUrl: ctx.workspaceUrl });
    if (common === undefined || common.ts === threadTs) {
      continue; // skip the parent message; it's captured as the top-level message
    }
    replies.push({
      channelId: ctx.channelId,
      threadTs,
      ...common,
      ...(ctx.channelName !== undefined ? { channelName: ctx.channelName } : {}),
    });
  }
  return replies;
}

/**
 * Select the channels to fetch: an explicit id allowlist (drops the rest), else every discovered channel.
 * Pure.
 *
 * @param discovered every channel discovery returned
 * @param channelFilter an optional explicit id allowlist
 * @returns the selected channels
 */
export function selectChannels({
  discovered,
  channelFilter,
}: {
  discovered: readonly { id: string; name?: string }[];
  channelFilter: readonly string[] | undefined;
}): readonly { id: string; name?: string }[] {
  if (channelFilter === undefined) {
    return discovered;
  }
  const filter = new Set(channelFilter);
  return discovered.filter((channel) => filter.has(channel.id));
}

/**
 * Merge per-channel thread-cursor updates onto a base map (base unmutated). Pure — the resume-cursor
 * bookkeeping is testable apart from the crawl.
 *
 * @param base the stored cursors going in
 * @param updates the newly-advanced cursors
 * @returns the merged cursor map
 */
export function mergeCursorUpdates({
  base,
  updates,
}: {
  base: Readonly<Record<string, string>>;
  updates: Readonly<Record<string, string>>;
}): Readonly<Record<string, string>> {
  return { ...base, ...updates };
}

/** Page a channel's history + each thread's NEW replies (since its stored cursor) into shaped items. */
async function fetchChannel({
  api,
  ctx,
  oldest,
  latest,
  threadCursors,
}: {
  api: SlackApi;
  ctx: ChannelContext;
  oldest: string;
  latest: string;
  threadCursors: ThreadCursors;
}): Promise<{
  items: SlackChannelItems;
  warnings: readonly string[];
  cursorUpdates: Readonly<Record<string, string>>;
}> {
  const { channelId, channelName } = ctx;
  const messages: SlackMessageItem[] = [];
  const replies: SlackReplyItem[] = [];
  const warnings: string[] = [];
  const cursorUpdates: Record<string, string> = {};
  const visited = new Set<string>();

  // Read one thread's NEW replies (since its stored cursor, else the window) + advance its cursor.
  const pollThread = async ({ threadTs, stored }: { threadTs: string; stored: string | undefined }): Promise<void> => {
    const threadResult = await fetchThread({ api, ctx, oldest: stored ?? oldest, threadTs });
    const fresh = newerReplies({ afterTs: stored, replies: threadResult.replies });
    replies.push(...fresh);
    warnings.push(...threadResult.warnings);
    const nextTs = latestReplyTs({ current: stored, replies: fresh });
    if (nextTs !== undefined) {
      cursorUpdates[threadKey({ channel: channelId, threadTs })] = nextTs;
    }
  };

  let cursor: string | undefined;
  do {
    const page = await api.history({ channel: channelId, latest, oldest, ...(cursor !== undefined ? { cursor } : {}) });
    messages.push(...shapeHistoryPage({ ctx, messages: page.messages }));
    for (const { threadTs } of planThreadPolls({ messages: page.messages })) {
      visited.add(threadKey({ channel: channelId, threadTs }));
      await pollThread({ stored: threadCursors[threadKey({ channel: channelId, threadTs })], threadTs });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor.length > 0);

  // Thread-delta: re-poll KNOWN threads in this channel whose parent fell OUTSIDE the window — a thread
  // can gain a new reply long after its parent's timestamp, which the source watermark alone would miss.
  const prefix = `${channelId}:`;
  for (const key of Object.keys(threadCursors)) {
    if (!key.startsWith(prefix) || visited.has(key)) {
      continue;
    }
    await pollThread({ stored: threadCursors[key], threadTs: key.slice(prefix.length) });
  }

  return {
    cursorUpdates,
    items: { channelId, messages, replies, ...(channelName !== undefined ? { channelName } : {}) },
    warnings,
  };
}

/** Page one thread's replies since `oldest` (the parent is skipped — it's already the top-level message). */
async function fetchThread({
  api,
  ctx,
  threadTs,
  oldest,
}: {
  api: SlackApi;
  ctx: ChannelContext;
  threadTs: string;
  oldest: string;
}): Promise<{ replies: readonly SlackReplyItem[]; warnings: readonly string[] }> {
  const replies: SlackReplyItem[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await api.replies({
        channel: ctx.channelId,
        oldest,
        ts: threadTs,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      replies.push(...shapeRepliesPage({ ctx, messages: page.messages, threadTs }));
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    return {
      replies,
      warnings: [
        `thread ${ctx.channelId}/${threadTs} replies failed: ${error instanceof Error ? error.message : "unknown"}`,
      ],
    };
  }
  return { replies, warnings: [] };
}

/** The workspace member's best display name: `profile.display_name` → `real_name` → `name`, else undefined. */
function memberName({ raw }: { raw: Record<string, unknown> }): string | undefined {
  const profile: Record<string, unknown> = isRecord(raw["profile"]) ? raw["profile"] : {};
  return (
    optStr({ value: profile["display_name"] }) ??
    optStr({ value: profile["real_name"] }) ??
    optStr({ value: raw["real_name"] }) ??
    optStr({ value: raw["name"] })
  );
}

/**
 * Build the workspace id→display-name map ONCE per refresh (`users.list`, paged). Used to resolve
 * `<@Uxxx>` mentions + file uploaders to human names. A failure is a warning + empty map, never fatal —
 * unresolved ids simply render as generic `@user` downstream.
 */
async function discoverUsers({
  api,
}: {
  api: SlackApi;
}): Promise<{ users: Record<string, string>; warnings: readonly string[] }> {
  const users: Record<string, string> = {};
  let cursor: string | undefined;
  try {
    do {
      const page = await api.listUsers(cursor !== undefined ? { cursor } : {});
      for (const raw of page.members) {
        if (!isRecord(raw)) {
          continue;
        }
        const id = optStr({ value: raw["id"] });
        const name = memberName({ raw });
        if (id !== undefined && name !== undefined) {
          users[id] = name;
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    return { users, warnings: [`user directory unavailable: ${error instanceof Error ? error.message : "unknown"}`] };
  }
  return { users, warnings: [] };
}

/** Enumerate EVERY channel `conversations.list` returns (paged) — no membership pre-filter; a channel
 * we cannot read is dropped later, at its history call, with a warning (breadth is the point). */
async function discoverChannels({ api }: { api: SlackApi }): Promise<readonly { id: string; name?: string }[]> {
  const channels: { id: string; name?: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await api.listChannels(cursor !== undefined ? { cursor } : {});
    for (const raw of page.channels) {
      if (!isRecord(raw)) {
        continue;
      }
      const id = optStr({ value: raw["id"] });
      const name = optStr({ value: raw["name"] });
      if (id !== undefined) {
        channels.push({ id, ...(name !== undefined ? { name } : {}) });
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor.length > 0);
  return channels;
}

/**
 * Fetch shaped Slack activity for every discovered channel (or an explicit filter) over the window
 * `[since, until]` (both bounds passed as Slack `oldest`/`latest`). Only channel DISCOVERY is fatal; an
 * unreadable channel's history, or a single thread's reply failure, is a warning + skip.
 *
 * @param api the injected Slack seam
 * @param window the export window (`since`→`oldest`, `until`→`latest`)
 * @param threadCursors the stored per-thread last-seen reply cursors (for incremental reply reads)
 * @param channelFilter optional explicit channel-id allowlist (else all discovered channels)
 * @returns the shaped items + warnings + the UPDATED thread cursors + the id→name maps, or `err` on a
 *   fatal discovery failure
 */
export async function fetchSlackActivity({
  api,
  window,
  threadCursors = {},
  channelFilter,
}: {
  api: SlackApi;
  window: ExportWindow;
  threadCursors?: ThreadCursors;
  channelFilter?: readonly string[];
}): Promise<
  Result<{
    channels: readonly SlackChannelItems[];
    warnings: readonly string[];
    threadCursors: ThreadCursors;
    maps: SlackNameMaps;
  }>
> {
  let workspaceUrl: string | undefined;
  let discovered: readonly { id: string; name?: string }[];
  try {
    workspaceUrl = await api.workspaceUrl();
    discovered = await discoverChannels({ api });
  } catch (error: unknown) {
    return err([`channel discovery failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  if (workspaceUrl === undefined) {
    return err(["could not resolve the workspace URL (auth.test) — check the token scopes"]);
  }
  const warnings: string[] = [];
  // The id→name maps are built ONCE per refresh: channels from discovery (every channel, so cross-channel
  // `<#Cxxx>` mentions resolve), users from `users.list`. They feed pure markup resolution in projection.
  const channelNames: Record<string, string> = {};
  for (const channel of discovered) {
    if (channel.name !== undefined) {
      channelNames[channel.id] = channel.name;
    }
  }
  const userDirectory = await discoverUsers({ api });
  warnings.push(...userDirectory.warnings);
  const maps: SlackNameMaps = { channelNames, userNames: userDirectory.users };
  const selected = selectChannels({ channelFilter, discovered });
  const oldest = dateToEpoch({ date: window.since, fallback: "0" });
  const latest = dateToEpoch({ date: window.until, fallback: "9999999999" });
  const channels: SlackChannelItems[] = [];
  let updatedCursors: Readonly<Record<string, string>> = { ...threadCursors };
  for (const channel of selected) {
    try {
      const result = await fetchChannel({
        api,
        ctx: { channelId: channel.id, channelName: channel.name, workspaceUrl },
        latest,
        oldest,
        threadCursors,
      });
      channels.push(result.items);
      warnings.push(...result.warnings);
      updatedCursors = mergeCursorUpdates({ base: updatedCursors, updates: result.cursorUpdates });
    } catch (error: unknown) {
      // A channel we can't read (e.g. not_in_channel) is skipped with a warning, never fatal — so one
      // unreadable channel never sinks the whole "all my channels" ingest.
      warnings.push(`channel ${channel.id} skipped: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  return ok({ channels, maps, threadCursors: updatedCursors, warnings });
}

/**
 * Build the production Slack seam over a live `WebClient`. The only place a real Slack client is
 * constructed; everything else runs against {@link SlackApi}.
 *
 * @param token the Slack bot/user token
 * @returns the live Slack seam
 */
export function makeSlackApi({ token }: { token: string }): SlackApi {
  const client = new WebClient(token);
  const nextCursorOf = (meta: { next_cursor?: string } | undefined): { nextCursor?: string } =>
    meta?.next_cursor !== undefined && meta.next_cursor.length > 0 ? { nextCursor: meta.next_cursor } : {};
  // Each raw SDK call is wrapped: transient-retried, then routed through safeApiCall (typed error) and
  // re-surfaced by orThrow so the fetchSlackActivity policy (channel/thread warnings, fatal discovery)
  // runs unchanged. The raw `client.*` boundary lives ONLY inside a safeApiCall execute here.
  return {
    history: async ({ channel, oldest, latest, cursor }) => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            retryTransient({
              operation: () =>
                client.conversations.history({
                  channel,
                  latest,
                  limit: PAGE_LIMIT,
                  oldest,
                  ...(cursor !== undefined ? { cursor } : {}),
                }),
            }),
          operation: "slack.conversations.history",
          provider: "slack",
        }),
      });
      return { messages: res.messages ?? [], ...nextCursorOf(res.response_metadata) };
    },
    listChannels: async ({ cursor }) => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            retryTransient({
              operation: () =>
                client.conversations.list({
                  exclude_archived: true,
                  limit: PAGE_LIMIT,
                  types: "public_channel,private_channel",
                  ...(cursor !== undefined ? { cursor } : {}),
                }),
            }),
          operation: "slack.conversations.list",
          provider: "slack",
        }),
      });
      return { channels: res.channels ?? [], ...nextCursorOf(res.response_metadata) };
    },
    listUsers: async ({ cursor }) => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            retryTransient({
              operation: () => client.users.list({ limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : {}) }),
            }),
          operation: "slack.users.list",
          provider: "slack",
        }),
      });
      return { members: res.members ?? [], ...nextCursorOf(res.response_metadata) };
    },
    replies: async ({ channel, ts, oldest, cursor }) => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            retryTransient({
              operation: () =>
                client.conversations.replies({
                  channel,
                  limit: PAGE_LIMIT,
                  oldest,
                  ts,
                  ...(cursor !== undefined ? { cursor } : {}),
                }),
            }),
          operation: "slack.conversations.replies",
          provider: "slack",
        }),
      });
      return { messages: res.messages ?? [], ...nextCursorOf(res.response_metadata) };
    },
    workspaceUrl: async () => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () => retryTransient({ operation: () => client.auth.test() }),
          operation: "slack.auth.test",
          provider: "slack",
        }),
      });
      return typeof res.url === "string" && res.url.length > 0 ? res.url : undefined;
    },
  };
}
