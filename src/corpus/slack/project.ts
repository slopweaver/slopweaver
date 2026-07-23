/**
 * Pure projection: shaped Slack items → `CorpusRecord[]`. No I/O — every network effect already
 * happened in `fetch.ts`. A channel's activity fans out into: one **message** record per top-level
 * message (`<channel>:<ts>`), one **comment** record per thread reply
 * (`<channel>:<threadTs>:reply:<replyTs>`), and one **file** record per attachment reference
 * (`<channel>:<messageTs>:file:<fileId>`) — refs only (filename/mimetype/title/alt/permalink), never
 * bytes or private download URLs. Ids are stable across re-fetches so dedup collapses re-ingested lines.
 *
 * Slack markup (`<@Uxxx>`, `<#Cxxx>`, `<url|label>`) is resolved to human text via the id→name maps the
 * fetch edge built, so no opaque `Uxxxx`/`Cxxxx` id ever lands in stored text (`resolveSlackMarkup`).
 */

import { CURATED_CLASS_ATTR } from "../curated/types.js";
import { extractRefs } from "../refs.js";
import type { CorpusAttributeValue, CorpusRecord } from "../types.js";

/** The id→name maps (users, channels) built once per refresh, used to resolve Slack markup. */
export interface SlackNameMaps {
  readonly userNames: Readonly<Record<string, string>>;
  readonly channelNames: Readonly<Record<string, string>>;
}

const EMPTY_MAPS: SlackNameMaps = { channelNames: {}, userNames: {} };

/** A referenced Slack file/image attachment — metadata only, no bytes. */
export interface SlackAttachmentRef {
  readonly id: string;
  readonly name?: string;
  readonly title?: string;
  readonly mimetype?: string;
  readonly altText?: string;
  /** The uploader's user id (resolved to a display name for the record's author). */
  readonly user?: string;
  /** Public/permalink metadata for citation; a signed private download URL is never persisted. */
  readonly permalink?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A top-level Slack message, already shaped + timestamped by the fetch edge (`text` absent ⇒ files-only). */
export interface SlackMessageItem {
  readonly channelId: string;
  readonly channelName?: string;
  readonly ts: string;
  readonly tsIso: string;
  readonly text?: string;
  readonly author?: string;
  readonly permalink: string;
  readonly reactions: readonly string[];
  readonly files: readonly SlackAttachmentRef[];
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A Slack thread reply (a message with a parent `threadTs`). */
export interface SlackReplyItem {
  readonly channelId: string;
  readonly channelName?: string;
  readonly threadTs: string;
  readonly ts: string;
  readonly tsIso: string;
  readonly text?: string;
  readonly author?: string;
  readonly permalink: string;
  readonly files: readonly SlackAttachmentRef[];
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** One channel's fetched activity: top-level messages + thread replies. */
export interface SlackChannelItems {
  readonly channelId: string;
  readonly channelName?: string;
  readonly messages: readonly SlackMessageItem[];
  readonly replies: readonly SlackReplyItem[];
}

/** A pinned message — the channel-curated knowledge a channel deliberately keeps (ref-only). */
export interface SlackPinItem {
  readonly channelId: string;
  readonly channelName?: string;
  readonly ts: string;
  readonly tsIso: string;
  readonly text?: string;
  readonly author?: string;
  readonly permalink: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A channel bookmark — a curated link the channel keeps. */
export interface SlackBookmarkItem {
  readonly channelId: string;
  readonly channelName?: string;
  readonly id: string;
  readonly title: string;
  readonly link: string;
  readonly tsIso: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A Slack canvas — a deliberately-authored doc (ref-only: title + permalink, never bytes/signed URLs). */
export interface SlackCanvasItem {
  readonly id: string;
  readonly title: string;
  readonly tsIso: string;
  readonly permalink: string;
  readonly channelId?: string;
  readonly author?: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** The curated Slack surfaces gathered by the best-effort curated lane. */
export interface SlackCuratedItems {
  readonly pins: readonly SlackPinItem[];
  readonly bookmarks: readonly SlackBookmarkItem[];
  readonly canvases: readonly SlackCanvasItem[];
}

/**
 * Resolve Slack markup to human-readable text: `<@Uxxx>`→`@Name`, `<#Cxxx>`→`#channel`, `<url|label>`→
 * `label`, bare `<url>`→`url`, `<!here>`→`@here`. On an id miss the pipe label is used, else a generic
 * `@user`/`#channel` — an opaque `Uxxxx`/`Cxxxx` is NEVER left in the text. Pure.
 *
 * @param text the raw message/comment text
 * @param maps the id→name maps from the fetch edge
 * @returns the text with all markup resolved
 */
export function resolveSlackMarkup({ text, maps }: { text: string; maps: SlackNameMaps }): string {
  return text.replace(/<([^>]+)>/g, (_match, inner: string) => {
    const pipe = inner.indexOf("|");
    const ref = pipe === -1 ? inner : inner.slice(0, pipe);
    const label = pipe === -1 ? undefined : inner.slice(pipe + 1);
    if (ref.startsWith("@")) {
      return `@${maps.userNames[ref.slice(1)] ?? label ?? "user"}`;
    }
    if (ref.startsWith("#")) {
      return `#${maps.channelNames[ref.slice(1)] ?? label ?? "channel"}`;
    }
    if (ref.startsWith("!")) {
      return `@${label ?? ref.slice(1)}`;
    }
    return label ?? ref;
  });
}

/** `slack/<channelId>` container (channel name folded into text/title, never the low-cardinality key). */
function containerFor({ channelId }: { channelId: string }): string {
  return `slack/${channelId}`;
}

/** A one-line reaction summary (`:emoji: x3`) appended to a message's text, when any. */
function reactionSummary({ reactions }: { reactions: readonly string[] }): string {
  return reactions.length > 0 ? `Reactions: ${reactions.join(", ")}` : "";
}

/** File attachment refs rendered as citable metadata text (never a signed URL). */
function fileSummary({ files }: { files: readonly SlackAttachmentRef[] }): string {
  if (files.length === 0) {
    return "";
  }
  const names = files.map((file) => file.title ?? file.name ?? file.id);
  return `Attachments: ${names.join(", ")}`;
}

/** Attachment display names (title→name→id) — reused for the file summary text and the rich attrs. */
function fileNames({ files }: { files: readonly SlackAttachmentRef[] }): readonly string[] {
  return files.map((file) => file.title ?? file.name ?? file.id);
}

/** Project one message into its `message` record plus a `file` record per attachment. */
function messageRecords({ message, maps }: { message: SlackMessageItem; maps: SlackNameMaps }): CorpusRecord[] {
  const container = containerFor({ channelId: message.channelId });
  const resolved = message.text !== undefined ? resolveSlackMarkup({ maps, text: message.text }) : undefined;
  const parts = [resolved, reactionSummary({ reactions: message.reactions }), fileSummary({ files: message.files })];
  const text = parts.filter((part): part is string => part !== undefined && part.length > 0).join("\n\n");
  const channelLabel = message.channelName !== undefined ? `#${message.channelName}` : message.channelId;
  const attrs: Record<string, CorpusAttributeValue> = { channel: channelLabel };
  if (message.reactions.length > 0) {
    attrs["reactions"] = message.reactions;
  }
  if (message.files.length > 0) {
    attrs["files"] = fileNames({ files: message.files });
  }
  const records: CorpusRecord[] = [
    {
      attrs,
      container,
      kind: "message",
      refs: resolved !== undefined ? extractRefs({ text: resolved }) : [],
      source: "slack",
      sourceId: `${message.channelId}:${message.ts}`,
      text: text.length > 0 ? text : `(empty message in ${channelLabel})`,
      title: `${channelLabel} message`,
      tsIso: message.tsIso,
      url: message.permalink,
      ...(message.author !== undefined ? { author: message.author } : {}),
      ...(message.raw !== undefined ? { raw: message.raw } : {}),
    },
  ];
  records.push(
    ...fileRecords({
      channelId: message.channelId,
      container,
      files: message.files,
      maps,
      parentTs: message.ts,
      permalink: message.permalink,
      tsIso: message.tsIso,
    }),
  );
  return records;
}

/** Project a thread reply into a `comment` record plus a `file` record per attachment. */
function replyRecords({ reply, maps }: { reply: SlackReplyItem; maps: SlackNameMaps }): CorpusRecord[] {
  const container = containerFor({ channelId: reply.channelId });
  const resolved = reply.text !== undefined ? resolveSlackMarkup({ maps, text: reply.text }) : undefined;
  const text = [resolved, fileSummary({ files: reply.files })]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
  const channelLabel = reply.channelName !== undefined ? `#${reply.channelName}` : reply.channelId;
  const attrs: Record<string, CorpusAttributeValue> = { channel: channelLabel, threadTs: reply.threadTs };
  if (reply.files.length > 0) {
    attrs["files"] = fileNames({ files: reply.files });
  }
  const records: CorpusRecord[] = [
    {
      attrs,
      container,
      kind: "comment",
      refs: resolved !== undefined ? extractRefs({ text: resolved }) : [],
      source: "slack",
      sourceId: `${reply.channelId}:${reply.threadTs}:reply:${reply.ts}`,
      text: text.length > 0 ? text : "(empty reply)",
      tsIso: reply.tsIso,
      url: reply.permalink,
      ...(reply.author !== undefined ? { author: reply.author } : {}),
      ...(reply.raw !== undefined ? { raw: reply.raw } : {}),
    },
  ];
  records.push(
    ...fileRecords({
      channelId: reply.channelId,
      container,
      files: reply.files,
      maps,
      parentTs: reply.ts,
      permalink: reply.permalink,
      tsIso: reply.tsIso,
    }),
  );
  return records;
}

/** One `file` record per attachment ref — cites the parent message permalink (files' own URLs expire). */
function fileRecords({
  files,
  container,
  parentTs,
  channelId,
  permalink,
  tsIso,
  maps,
}: {
  files: readonly SlackAttachmentRef[];
  container: string;
  parentTs: string;
  channelId: string;
  permalink: string;
  tsIso: string;
  maps: SlackNameMaps;
}): CorpusRecord[] {
  return files.map((file): CorpusRecord => {
    const label = file.title ?? file.name ?? file.id;
    const descriptor = [file.mimetype, file.altText].filter(
      (part): part is string => part !== undefined && part.length > 0,
    );
    const text = [`File: ${label}`, ...descriptor].join(" · ");
    const author = file.user !== undefined ? maps.userNames[file.user] : undefined;
    return {
      container,
      kind: "file",
      refs: [],
      source: "slack",
      sourceId: `${channelId}:${parentTs}:file:${file.id}`,
      text,
      title: label,
      tsIso,
      url: file.permalink ?? permalink,
      ...(author !== undefined ? { author } : {}),
      ...(file.raw !== undefined ? { raw: file.raw } : {}),
    };
  });
}

/** The empty curated surfaces (so the default is stable). */
const EMPTY_CURATED: SlackCuratedItems = { bookmarks: [], canvases: [], pins: [] };

/** One `pin` record — a channel-curated pinned message, resolved + cited by its permalink. Pure. */
function pinRecord({ pin, maps }: { pin: SlackPinItem; maps: SlackNameMaps }): CorpusRecord {
  const channelLabel = pin.channelName !== undefined ? `#${pin.channelName}` : pin.channelId;
  const resolved = pin.text !== undefined ? resolveSlackMarkup({ maps, text: pin.text }) : undefined;
  return {
    attrs: { channel: channelLabel },
    container: containerFor({ channelId: pin.channelId }),
    kind: "pin",
    refs: resolved !== undefined ? extractRefs({ text: resolved }) : [],
    source: "slack",
    sourceId: `${pin.channelId}:pin:${pin.ts}`,
    text: resolved !== undefined && resolved.length > 0 ? resolved : `Pinned message in ${channelLabel}`,
    title: `${channelLabel} pinned`,
    tsIso: pin.tsIso,
    url: pin.permalink,
    ...(pin.author !== undefined ? { author: pin.author } : {}),
    ...(pin.raw !== undefined ? { raw: pin.raw } : {}),
  };
}

/** One `bookmark` record — a curated channel link (ref-only). Pure. */
function bookmarkRecord({ bookmark }: { bookmark: SlackBookmarkItem }): CorpusRecord {
  const channelLabel = bookmark.channelName !== undefined ? `#${bookmark.channelName}` : bookmark.channelId;
  return {
    attrs: { channel: channelLabel },
    container: containerFor({ channelId: bookmark.channelId }),
    kind: "bookmark",
    refs: extractRefs({ text: bookmark.link }),
    source: "slack",
    sourceId: `${bookmark.channelId}:bookmark:${bookmark.id}`,
    text: bookmark.title.length > 0 ? bookmark.title : bookmark.link,
    title: bookmark.title.length > 0 ? bookmark.title : "bookmark",
    tsIso: bookmark.tsIso,
    url: bookmark.link,
    ...(bookmark.raw !== undefined ? { raw: bookmark.raw } : {}),
  };
}

/** One `canvas` record — a deliberately-authored doc (ref-only), classified `strategy`. Pure. */
function canvasRecord({ canvas }: { canvas: SlackCanvasItem }): CorpusRecord {
  return {
    attrs: { [CURATED_CLASS_ATTR]: "strategy" },
    container: canvas.channelId !== undefined ? containerFor({ channelId: canvas.channelId }) : "slack",
    kind: "canvas",
    refs: [],
    source: "slack",
    sourceId: `canvas:${canvas.id}`,
    text: canvas.title.length > 0 ? canvas.title : `Canvas ${canvas.id}`,
    title: canvas.title.length > 0 ? canvas.title : "canvas",
    tsIso: canvas.tsIso,
    url: canvas.permalink,
    ...(canvas.author !== undefined ? { author: canvas.author } : {}),
    ...(canvas.raw !== undefined ? { raw: canvas.raw } : {}),
  };
}

/**
 * Project every channel's messages + replies (+ their attachment refs) and the curated surfaces
 * (pins/bookmarks/canvases) into corpus records, resolving Slack markup via the id→name maps.
 *
 * @param channels the fetched per-channel items
 * @param maps the id→name maps for markup resolution (defaults to empty — renders generic names)
 * @param curated the curated surfaces gathered by the best-effort lane (defaults to empty)
 * @returns the flattened corpus records
 */
export function projectSlackRecords({
  channels,
  maps = EMPTY_MAPS,
  curated = EMPTY_CURATED,
}: {
  channels: readonly SlackChannelItems[];
  maps?: SlackNameMaps;
  curated?: SlackCuratedItems;
}): readonly CorpusRecord[] {
  const records: CorpusRecord[] = [];
  for (const channel of channels) {
    for (const message of channel.messages) {
      records.push(...messageRecords({ maps, message }));
    }
    for (const reply of channel.replies) {
      records.push(...replyRecords({ maps, reply }));
    }
  }
  for (const pin of curated.pins) {
    records.push(pinRecord({ maps, pin }));
  }
  for (const bookmark of curated.bookmarks) {
    records.push(bookmarkRecord({ bookmark }));
  }
  for (const canvas of curated.canvases) {
    records.push(canvasRecord({ canvas }));
  }
  return records;
}
