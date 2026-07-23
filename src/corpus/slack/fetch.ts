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

import { yyyyMmDdToEpochSeconds } from "../../lib/date.js";
import { collectCursorPages } from "../../lib/paging.js";
import { isRecord } from "../../lib/parsers.js";
import { retryTransient } from "../../lib/resilience.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import { buildMemberIdentity, finaliseMemberTrust } from "../members/email.js";
import { aggregateMemberWarnings } from "../members/project.js";
import type { MemberBronzeRow } from "../members/types.js";
import type { ExportWindow } from "../types.js";
import { shapeBookmark, shapeCanvasFile, shapePin } from "./curated.js";
import type {
  SlackAttachmentRef,
  SlackBookmarkItem,
  SlackCanvasItem,
  SlackChannelItems,
  SlackCuratedItems,
  SlackMessageItem,
  SlackNameMaps,
  SlackPinItem,
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

/** A page of raw files from `files.list` (used for the durable canvas-discovery path). */
export interface SlackFilesPage {
  readonly files: readonly unknown[];
  readonly nextCursor?: string;
}

/**
 * Injected Slack seam. Raw shapes stay `unknown`; the fetch parses them defensively. The curated methods
 * (`pins`/`bookmarks`/`files`) are OPTIONAL — a best-effort lane whose absence or failure degrades to a
 * warning, never a fatal error (so a missing scope never sinks the message crawl).
 */
export interface SlackApi {
  workspaceUrl: () => Promise<string | undefined>;
  listChannels: (args: { cursor?: string }) => Promise<SlackChannelsPage>;
  listUsers: (args: { cursor?: string }) => Promise<SlackUsersPage>;
  history: (args: { channel: string; oldest: string; latest: string; cursor?: string }) => Promise<SlackMessagesPage>;
  replies: (args: { channel: string; ts: string; oldest: string; cursor?: string }) => Promise<SlackMessagesPage>;
  pins?: (args: { channel: string }) => Promise<{ items: readonly unknown[] }>;
  bookmarks?: (args: { channel: string }) => Promise<{ bookmarks: readonly unknown[] }>;
  files?: (args: { cursor?: string }) => Promise<SlackFilesPage>;
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
  const seconds = yyyyMmDdToEpochSeconds({ date });
  return seconds === undefined ? fallback : String(seconds);
}

/**
 * The Slack `[oldest, latest]` epoch-seconds bounds for an export window (an unparseable bound falls back
 * to the widest sentinel, matching the historical behaviour). Pure.
 *
 * @param window the export window
 * @returns the Slack `oldest`/`latest` bounds
 */
export function slackWindowBounds({ window }: { window: ExportWindow }): { oldest: string; latest: string } {
  return {
    latest: dateToEpoch({ date: window.until, fallback: "9999999999" }),
    oldest: dateToEpoch({ date: window.since, fallback: "0" }),
  };
}

/**
 * The id→display-name map for discovered channels (used to resolve cross-channel `<#Cxxx>` mentions). Pure.
 *
 * @param discovered every discovered channel
 * @returns the id→name map (channels without a name are omitted)
 */
export function channelNameMap({
  discovered,
}: {
  discovered: readonly { id: string; name?: string }[];
}): Record<string, string> {
  const names: Record<string, string> = {};
  for (const channel of discovered) {
    if (channel.name !== undefined) {
      names[channel.id] = channel.name;
    }
  }
  return names;
}

/** The `nextCursor` off a Slack `response_metadata` — absent/empty ⇒ stop paging. Pure. */
export function slackNextCursor({ metadata }: { metadata: { next_cursor?: string } | undefined }): {
  nextCursor?: string;
} {
  return metadata?.next_cursor !== undefined && metadata.next_cursor.length > 0
    ? { nextCursor: metadata.next_cursor }
    : {};
}

/** Concatenate two warning lists (neither mutated). Pure. */
export function mergeSlackWarnings({
  base,
  extra,
}: {
  base: readonly string[];
  extra: readonly string[];
}): readonly string[] {
  return [...base, ...extra];
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

/** One thread's contribution: its NEW replies, any warning, and the cursor advance (absent ⇒ no advance). */
interface ThreadPoll {
  readonly replies: readonly SlackReplyItem[];
  readonly warnings: readonly string[];
  readonly cursorUpdate?: { readonly key: string; readonly ts: string };
}

/** Read one thread's NEW replies (from its stored cursor, else the window) + compute its cursor advance. */
async function pollThread({
  api,
  ctx,
  threadTs,
  stored,
  windowOldest,
}: {
  api: SlackApi;
  ctx: ChannelContext;
  threadTs: string;
  stored: string | undefined;
  windowOldest: string;
}): Promise<ThreadPoll> {
  const threadResult = await fetchThread({ api, ctx, oldest: stored ?? windowOldest, threadTs });
  const fresh = newerReplies({ afterTs: stored, replies: threadResult.replies });
  const nextTs = latestReplyTs({ current: stored, replies: fresh });
  return {
    replies: fresh,
    warnings: threadResult.warnings,
    ...(nextTs !== undefined
      ? { cursorUpdate: { key: threadKey({ channel: ctx.channelId, threadTs }), ts: nextTs } }
      : {}),
  };
}

/** A mutable per-channel accumulator the paging loop folds thread polls + shaped messages into. */
interface ChannelCrawl {
  readonly messages: SlackMessageItem[];
  readonly replies: SlackReplyItem[];
  readonly warnings: string[];
  readonly cursorUpdates: Record<string, string>;
  readonly visited: Set<string>;
}

/** Fold one thread poll into the channel accumulator (replies + warnings + cursor advance). */
function absorbPoll({ crawl, poll }: { crawl: ChannelCrawl; poll: ThreadPoll }): void {
  crawl.replies.push(...poll.replies);
  crawl.warnings.push(...poll.warnings);
  if (poll.cursorUpdate !== undefined) {
    crawl.cursorUpdates[poll.cursorUpdate.key] = poll.cursorUpdate.ts;
  }
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
  const crawl: ChannelCrawl = { cursorUpdates: {}, messages: [], replies: [], visited: new Set(), warnings: [] };
  let cursor: string | undefined;
  do {
    const page = await api.history({ channel: channelId, latest, oldest, ...(cursor !== undefined ? { cursor } : {}) });
    crawl.messages.push(...shapeHistoryPage({ ctx, messages: page.messages }));
    for (const { threadTs } of planThreadPolls({ messages: page.messages })) {
      crawl.visited.add(threadKey({ channel: channelId, threadTs }));
      const stored = threadCursors[threadKey({ channel: channelId, threadTs })];
      absorbPoll({ crawl, poll: await pollThread({ api, ctx, stored, threadTs, windowOldest: oldest }) });
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor.length > 0);

  // Thread-delta: re-poll KNOWN threads in this channel whose parent fell OUTSIDE the window — a thread
  // can gain a new reply long after its parent's timestamp, which the source watermark alone would miss.
  const prefix = `${channelId}:`;
  for (const key of Object.keys(threadCursors)) {
    if (!key.startsWith(prefix) || crawl.visited.has(key)) {
      continue;
    }
    const poll = await pollThread({
      api,
      ctx,
      stored: threadCursors[key],
      threadTs: key.slice(prefix.length),
      windowOldest: oldest,
    });
    absorbPoll({ crawl, poll });
  }

  return {
    cursorUpdates: crawl.cursorUpdates,
    items: {
      channelId,
      messages: crawl.messages,
      replies: crawl.replies,
      ...(channelName !== undefined ? { channelName } : {}),
    },
    warnings: crawl.warnings,
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
/** The id→name entries from one `users.list` page (skips non-object / id-less / name-less rows). Pure. */
export function usersFromPage({ members }: { members: readonly unknown[] }): Record<string, string> {
  const users: Record<string, string> = {};
  for (const raw of members) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = optStr({ value: raw["id"] });
    const name = memberName({ raw });
    if (id !== undefined && name !== undefined) {
      users[id] = name;
    }
  }
  return users;
}

/** The Slack member profile object (defensively `{}` when absent). */
function slackProfile({ raw }: { raw: Record<string, unknown> }): Record<string, unknown> {
  return isRecord(raw["profile"]) ? raw["profile"] : {};
}

/**
 * Project one raw Slack `users.list` member into a {@link MemberBronzeRow}. The full raw Member is kept;
 * `profile.email` populates the join key ONLY when the `users:read.email` scope granted it (else a warning
 * + `missing` trust — never a guessed email). Pure — undefined for an id-less row.
 *
 * @param raw the raw member object
 * @param fetchedAtIso the hydration timestamp
 * @returns the member row, or `undefined` when it has no id
 */
export function projectSlackMember({
  raw,
  fetchedAtIso,
}: {
  raw: unknown;
  fetchedAtIso: string;
}): MemberBronzeRow | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const id = optStr({ value: raw["id"] });
  if (id === undefined) {
    return undefined;
  }
  const profile = slackProfile({ raw });
  const email = optStr({ value: profile["email"] });
  const handle = optStr({ value: raw["name"] });
  const name = memberName({ raw });
  const title = optStr({ value: profile["title"] });
  const timezone = optStr({ value: raw["tz"] });
  const guest = raw["is_restricted"] === true || raw["is_ultra_restricted"] === true;
  const avatarUrl = optStr({ value: profile["image_512"] }) ?? optStr({ value: profile["image_192"] });
  return {
    fetchedAtIso,
    identity: buildMemberIdentity({
      nativeId: id,
      source: "slack",
      ...(handle !== undefined ? { handle } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
    }),
    profile: {
      active: raw["deleted"] !== true,
      bot: raw["is_bot"] === true,
      guest,
      ...(raw["is_admin"] === true ? { admin: true } : {}),
      ...(title !== undefined ? { title } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    },
    provenance: ["slack.users.list"],
    raw,
    source: "slack",
    sourceId: id,
    version: 1,
    warnings: email === undefined ? ["no email — set the users:read.email scope for cross-source linking"] : [],
  };
}

/**
 * Hydrate every Slack workspace member (`users.list`, paged) into member rows, with trust finalised across
 * the workspace. Reuses the existing safe-wrapped `listUsers` seam — no new boundary. A discovery failure
 * is fatal (`err`); an empty workspace is `ok([])`.
 *
 * @param api the injected Slack seam
 * @param fetchedAtIso the hydration timestamp
 * @returns the member rows + warnings, or `err` on a fatal discovery failure
 */
export async function fetchSlackMembers({
  api,
  fetchedAtIso,
}: {
  api: SlackApi;
  fetchedAtIso: string;
}): Promise<Result<{ rows: readonly MemberBronzeRow[]; warnings: readonly string[] }>> {
  const rows: MemberBronzeRow[] = [];
  let cursor: string | undefined;
  try {
    do {
      const page = await api.listUsers(cursor !== undefined ? { cursor } : {});
      for (const raw of page.members) {
        const row = projectSlackMember({ fetchedAtIso, raw });
        if (row !== undefined) {
          rows.push(row);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    return err([`slack member hydration failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  const finalised = finaliseMemberTrust({ rows });
  return ok({ rows: finalised, warnings: aggregateMemberWarnings({ rows: finalised }) });
}

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
      Object.assign(users, usersFromPage({ members: page.members }));
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    // Non-fatal: return whatever was accumulated before the failure + a warning (unchanged behaviour).
    return { users, warnings: [`user directory unavailable: ${error instanceof Error ? error.message : "unknown"}`] };
  }
  return { users, warnings: [] };
}

/** Enumerate EVERY channel `conversations.list` returns (paged) — no membership pre-filter; a channel
 * we cannot read is dropped later, at its history call, with a warning (breadth is the point). */
/** The `{id, name?}` channels from one `conversations.list` page (skips non-object / id-less rows). Pure. */
export function channelsFromPage({
  channels,
}: {
  channels: readonly unknown[];
}): readonly { id: string; name?: string }[] {
  const out: { id: string; name?: string }[] = [];
  for (const raw of channels) {
    if (!isRecord(raw)) {
      continue;
    }
    const id = optStr({ value: raw["id"] });
    const name = optStr({ value: raw["name"] });
    if (id !== undefined) {
      out.push({ id, ...(name !== undefined ? { name } : {}) });
    }
  }
  return out;
}

async function discoverChannels({ api }: { api: SlackApi }): Promise<readonly { id: string; name?: string }[]> {
  return collectCursorPages({
    fetchPage: ({ cursor }) =>
      api
        .listChannels(cursor !== undefined ? { cursor } : {})
        .then((page) => ({ items: channelsFromPage({ channels: page.channels }), nextCursor: page.nextCursor })),
  });
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
    curated: SlackCuratedItems;
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
  // The id→name maps are built ONCE per refresh: channels from discovery (every channel, so cross-channel
  // `<#Cxxx>` mentions resolve), users from `users.list`. They feed pure markup resolution in projection.
  const userDirectory = await discoverUsers({ api });
  const maps: SlackNameMaps = { channelNames: channelNameMap({ discovered }), userNames: userDirectory.users };
  const selected = selectChannels({ channelFilter, discovered });
  const crawl = await crawlChannels({
    api,
    bounds: slackWindowBounds({ window }),
    selected,
    threadCursors,
    workspaceUrl,
  });
  const curated = await fetchSlackCurated({ api, maps, selected, workspaceUrl });
  return ok({
    channels: crawl.channels,
    curated: curated.items,
    maps,
    threadCursors: crawl.cursors,
    warnings: mergeSlackWarnings({ base: [...userDirectory.warnings, ...crawl.warnings], extra: curated.warnings }),
  });
}

/**
 * Gather the curated Slack surfaces best-effort: pins + bookmarks per selected channel, and canvases via
 * a workspace-wide `files.list`. Every lane is optional (a missing method or a scope gap warns + skips),
 * so the curated pass NEVER sinks the message crawl. Ref-only throughout.
 */
async function fetchSlackCurated({
  api,
  selected,
  workspaceUrl,
  maps,
}: {
  api: SlackApi;
  selected: readonly { id: string; name?: string }[];
  workspaceUrl: string;
  maps: SlackNameMaps;
}): Promise<{ items: SlackCuratedItems; warnings: readonly string[] }> {
  const pins: SlackPinItem[] = [];
  const bookmarks: SlackBookmarkItem[] = [];
  const warnings: string[] = [];
  for (const channel of selected) {
    pins.push(...(await channelPins({ api, channel, maps, warnings, workspaceUrl })));
    bookmarks.push(...(await channelBookmarks({ api, channel, warnings })));
  }
  const canvases = await workspaceCanvases({ api, warnings });
  return { items: { bookmarks, canvases, pins }, warnings };
}

/** One channel's pinned messages (best-effort — a scope gap/failure warns + returns none). */
async function channelPins({
  api,
  channel,
  workspaceUrl,
  maps,
  warnings,
}: {
  api: SlackApi;
  channel: { id: string; name?: string };
  workspaceUrl: string;
  maps: SlackNameMaps;
  warnings: string[];
}): Promise<readonly SlackPinItem[]> {
  if (api.pins === undefined) {
    return [];
  }
  try {
    const res = await api.pins({ channel: channel.id });
    return res.items
      .map((item) => {
        const author = pinAuthor({ item, maps });
        return shapePin({
          channelId: channel.id,
          item,
          workspaceUrl,
          ...(channel.name !== undefined ? { channelName: channel.name } : {}),
          ...(author !== undefined ? { authorName: author } : {}),
        });
      })
      .filter((pin): pin is SlackPinItem => pin !== undefined);
  } catch (error: unknown) {
    warnings.push(`slack pins for ${channel.id} skipped: ${error instanceof Error ? error.message : "unknown"}`);
    return [];
  }
}

/** The resolved display name of a pinned message's author (via the user map), or undefined. Pure. */
function pinAuthor({ item, maps }: { item: unknown; maps: SlackNameMaps }): string | undefined {
  const message = isRecord(item) && isRecord(item["message"]) ? item["message"] : undefined;
  const user = message !== undefined && typeof message["user"] === "string" ? message["user"] : undefined;
  return user !== undefined ? maps.userNames[user] : undefined;
}

/** One channel's bookmarks (best-effort — a scope gap/failure warns + returns none). */
async function channelBookmarks({
  api,
  channel,
  warnings,
}: {
  api: SlackApi;
  channel: { id: string; name?: string };
  warnings: string[];
}): Promise<readonly SlackBookmarkItem[]> {
  if (api.bookmarks === undefined) {
    return [];
  }
  try {
    const res = await api.bookmarks({ channel: channel.id });
    return res.bookmarks
      .map((raw) =>
        shapeBookmark({
          channelId: channel.id,
          raw,
          ...(channel.name !== undefined ? { channelName: channel.name } : {}),
        }),
      )
      .filter((bookmark): bookmark is SlackBookmarkItem => bookmark !== undefined);
  } catch (error: unknown) {
    warnings.push(`slack bookmarks for ${channel.id} skipped: ${error instanceof Error ? error.message : "unknown"}`);
    return [];
  }
}

/** Every workspace canvas via `files.list` (best-effort, paged; non-canvas files are dropped). */
async function workspaceCanvases({
  api,
  warnings,
}: {
  api: SlackApi;
  warnings: string[];
}): Promise<readonly SlackCanvasItem[]> {
  const fetchFiles = api.files;
  if (fetchFiles === undefined) {
    return [];
  }
  try {
    const files = await collectCursorPages({
      fetchPage: ({ cursor }) =>
        fetchFiles(cursor !== undefined ? { cursor } : {}).then((page) => ({
          items: page.files,
          nextCursor: page.nextCursor,
        })),
    });
    return files
      .map((file) => shapeCanvasFile({ file }))
      .filter((canvas): canvas is SlackCanvasItem => canvas !== undefined);
  } catch (error: unknown) {
    warnings.push(`slack canvases skipped: ${error instanceof Error ? error.message : "unknown"}`);
    return [];
  }
}

/** Crawl each selected channel (unreadable ones warn + skip, never fatal), merging warnings + cursors. */
async function crawlChannels({
  api,
  selected,
  workspaceUrl,
  bounds,
  threadCursors,
}: {
  api: SlackApi;
  selected: readonly { id: string; name?: string }[];
  workspaceUrl: string;
  bounds: { oldest: string; latest: string };
  threadCursors: ThreadCursors;
}): Promise<{
  channels: readonly SlackChannelItems[];
  warnings: readonly string[];
  cursors: ThreadCursors;
}> {
  const channels: SlackChannelItems[] = [];
  const warnings: string[] = [];
  let cursors: Readonly<Record<string, string>> = { ...threadCursors };
  for (const channel of selected) {
    try {
      const result = await fetchChannel({
        api,
        ctx: { channelId: channel.id, channelName: channel.name, workspaceUrl },
        latest: bounds.latest,
        oldest: bounds.oldest,
        threadCursors,
      });
      channels.push(result.items);
      warnings.push(...result.warnings);
      cursors = mergeCursorUpdates({ base: cursors, updates: result.cursorUpdates });
    } catch (error: unknown) {
      // A channel we can't read (e.g. not_in_channel) is skipped with a warning, never fatal — so one
      // unreadable channel never sinks the whole "all my channels" ingest.
      warnings.push(`channel ${channel.id} skipped: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  return { channels, cursors, warnings };
}

// Each factory wraps ONE raw SDK call: transient-retried, routed through safeApiCall (typed error) and
// re-surfaced by orThrow so the fetchSlackActivity policy (channel/thread warnings, fatal discovery) runs
// unchanged. The raw `client.*` boundary lives ONLY inside a safeApiCall execute — one call per factory,
// so each stays small + the boundary-residue gate sees the client call inside a safe* wrapper.

/** The live `conversations.history` seam method. */
function slackHistory({ client }: { client: WebClient }): SlackApi["history"] {
  return async ({ channel, oldest, latest, cursor }) => {
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
    return { messages: res.messages ?? [], ...slackNextCursor({ metadata: res.response_metadata }) };
  };
}

/** The live `conversations.list` seam method. */
function slackListChannels({ client }: { client: WebClient }): SlackApi["listChannels"] {
  return async ({ cursor }) => {
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
    return { channels: res.channels ?? [], ...slackNextCursor({ metadata: res.response_metadata }) };
  };
}

/** The live `users.list` seam method. */
function slackListUsers({ client }: { client: WebClient }): SlackApi["listUsers"] {
  return async ({ cursor }) => {
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
    return { members: res.members ?? [], ...slackNextCursor({ metadata: res.response_metadata }) };
  };
}

/** The live `conversations.replies` seam method. */
function slackReplies({ client }: { client: WebClient }): SlackApi["replies"] {
  return async ({ channel, ts, oldest, cursor }) => {
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
    return { messages: res.messages ?? [], ...slackNextCursor({ metadata: res.response_metadata }) };
  };
}

/** The live `auth.test` → workspace-url seam method. */
function slackWorkspaceUrl({ client }: { client: WebClient }): SlackApi["workspaceUrl"] {
  return async () => {
    const res = orThrow({
      result: await safeApiCall({
        execute: () => retryTransient({ operation: () => client.auth.test() }),
        operation: "slack.auth.test",
        provider: "slack",
      }),
    });
    return typeof res.url === "string" && res.url.length > 0 ? res.url : undefined;
  };
}

/** The live `pins.list` seam method (curated lane). */
function slackPins({ client }: { client: WebClient }): NonNullable<SlackApi["pins"]> {
  return async ({ channel }) => {
    const res = orThrow({
      result: await safeApiCall({
        execute: () => retryTransient({ operation: () => client.pins.list({ channel }) }),
        operation: "slack.pins.list",
        provider: "slack",
      }),
    });
    return { items: res.items ?? [] };
  };
}

/** The live `bookmarks.list` seam method (curated lane). */
function slackBookmarks({ client }: { client: WebClient }): NonNullable<SlackApi["bookmarks"]> {
  return async ({ channel }) => {
    const res = orThrow({
      result: await safeApiCall({
        execute: () => retryTransient({ operation: () => client.bookmarks.list({ channel_id: channel }) }),
        operation: "slack.bookmarks.list",
        provider: "slack",
      }),
    });
    return { bookmarks: res.bookmarks ?? [] };
  };
}

/**
 * The live `files.list` seam method (curated canvas-discovery lane). `files.list` uses legacy count/page
 * pagination, not cursors; canvases are few, so we fetch one generous page and surface no next cursor.
 */
function slackFiles({ client }: { client: WebClient }): NonNullable<SlackApi["files"]> {
  return async () => {
    const res = orThrow({
      result: await safeApiCall({
        execute: () => retryTransient({ operation: () => client.files.list({ count: PAGE_LIMIT }) }),
        operation: "slack.files.list",
        provider: "slack",
      }),
    });
    return { files: res.files ?? [] };
  };
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
  return {
    bookmarks: slackBookmarks({ client }),
    files: slackFiles({ client }),
    history: slackHistory({ client }),
    listChannels: slackListChannels({ client }),
    listUsers: slackListUsers({ client }),
    pins: slackPins({ client }),
    replies: slackReplies({ client }),
    workspaceUrl: slackWorkspaceUrl({ client }),
  };
}
