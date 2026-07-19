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
import { err, ok, type Result } from "../../lib/result.js";
import { retry } from "../../lib/retry.js";
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
    ts,
    tsIso: tsToIso({ ts }),
    ...(author !== undefined ? { author } : {}),
    ...(text !== undefined ? { text } : {}),
  };
}

/** Page a channel's history + each thread's NEW replies (since its stored cursor) into shaped items. */
async function fetchChannel({
  api,
  workspaceUrl,
  channelId,
  channelName,
  oldest,
  latest,
  threadCursors,
}: {
  api: SlackApi;
  workspaceUrl: string;
  channelId: string;
  channelName: string | undefined;
  oldest: string;
  latest: string;
  threadCursors: ThreadCursors;
}): Promise<{
  items: SlackChannelItems;
  warnings: readonly string[];
  cursorUpdates: Readonly<Record<string, string>>;
}> {
  const messages: SlackMessageItem[] = [];
  const replies: SlackReplyItem[] = [];
  const warnings: string[] = [];
  const cursorUpdates: Record<string, string> = {};
  const visited = new Set<string>();

  // Read one thread's NEW replies (since its stored cursor, else the window) + advance its cursor.
  const pollThread = async ({ threadTs, stored }: { threadTs: string; stored: string | undefined }): Promise<void> => {
    const threadResult = await fetchThread({
      api,
      channelId,
      channelName,
      oldest: stored ?? oldest,
      threadTs,
      workspaceUrl,
    });
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
    for (const raw of page.messages) {
      if (!isRecord(raw)) {
        continue;
      }
      const common = shapeCommon({ channelId, raw, workspaceUrl });
      if (common === undefined) {
        continue;
      }
      messages.push({
        channelId,
        reactions: shapeReactions({ raw: raw["reactions"] }),
        ...common,
        ...(channelName !== undefined ? { channelName } : {}),
      });
      const replyCount = typeof raw["reply_count"] === "number" ? raw["reply_count"] : 0;
      if (replyCount > 0) {
        const key = threadKey({ channel: channelId, threadTs: common.ts });
        visited.add(key);
        await pollThread({ stored: threadCursors[key], threadTs: common.ts });
      }
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
  workspaceUrl,
  channelId,
  channelName,
  threadTs,
  oldest,
}: {
  api: SlackApi;
  workspaceUrl: string;
  channelId: string;
  channelName: string | undefined;
  threadTs: string;
  oldest: string;
}): Promise<{ replies: readonly SlackReplyItem[]; warnings: readonly string[] }> {
  const replies: SlackReplyItem[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await api.replies({
        channel: channelId,
        oldest,
        ts: threadTs,
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const raw of page.messages) {
        if (!isRecord(raw)) {
          continue;
        }
        const common = shapeCommon({ channelId, raw, workspaceUrl });
        if (common === undefined || common.ts === threadTs) {
          continue; // skip the parent message; it's captured as the top-level message
        }
        replies.push({ channelId, threadTs, ...common, ...(channelName !== undefined ? { channelName } : {}) });
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    return {
      replies,
      warnings: [
        `thread ${channelId}/${threadTs} replies failed: ${error instanceof Error ? error.message : "unknown"}`,
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
  const filter = channelFilter !== undefined ? new Set(channelFilter) : undefined;
  const selected = filter !== undefined ? discovered.filter((channel) => filter.has(channel.id)) : discovered;
  const oldest = dateToEpoch({ date: window.since, fallback: "0" });
  const latest = dateToEpoch({ date: window.until, fallback: "9999999999" });
  const channels: SlackChannelItems[] = [];
  const updatedCursors: Record<string, string> = { ...threadCursors };
  for (const channel of selected) {
    try {
      const result = await fetchChannel({
        api,
        channelId: channel.id,
        channelName: channel.name,
        latest,
        oldest,
        threadCursors,
        workspaceUrl,
      });
      channels.push(result.items);
      warnings.push(...result.warnings);
      Object.assign(updatedCursors, result.cursorUpdates);
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
  return {
    history: async ({ channel, oldest, latest, cursor }) => {
      const res = await retry({
        operation: () =>
          client.conversations.history({
            channel,
            latest,
            limit: PAGE_LIMIT,
            oldest,
            ...(cursor !== undefined ? { cursor } : {}),
          }),
      });
      return { messages: res.messages ?? [], ...nextCursorOf(res.response_metadata) };
    },
    listChannels: async ({ cursor }) => {
      const res = await retry({
        operation: () =>
          client.conversations.list({
            exclude_archived: true,
            limit: PAGE_LIMIT,
            types: "public_channel,private_channel",
            ...(cursor !== undefined ? { cursor } : {}),
          }),
      });
      return { channels: res.channels ?? [], ...nextCursorOf(res.response_metadata) };
    },
    listUsers: async ({ cursor }) => {
      const res = await retry({
        operation: () => client.users.list({ limit: PAGE_LIMIT, ...(cursor !== undefined ? { cursor } : {}) }),
      });
      return { members: res.members ?? [], ...nextCursorOf(res.response_metadata) };
    },
    replies: async ({ channel, ts, oldest, cursor }) => {
      const res = await retry({
        operation: () =>
          client.conversations.replies({
            channel,
            limit: PAGE_LIMIT,
            oldest,
            ts,
            ...(cursor !== undefined ? { cursor } : {}),
          }),
      });
      return { messages: res.messages ?? [], ...nextCursorOf(res.response_metadata) };
    },
    workspaceUrl: async () => {
      const res = await retry({ operation: () => client.auth.test() });
      return typeof res.url === "string" && res.url.length > 0 ? res.url : undefined;
    },
  };
}
