/**
 * Pure Slack curated-layer shapers (PR4.3): turn raw `pins.list` / `bookmarks.list` / `files.list`
 * payloads into the ref-only curated items `project.ts` consumes. No I/O.
 *
 * Everything here is ref-only: a pin cites its message permalink, a bookmark its link, a canvas its
 * permalink. A file's private/signed download URL (`url_private`) is NEVER persisted — the shipped
 * Slack-attachment floor.
 */
import { isRecord } from "../../lib/parsers.js";
import type { SlackBookmarkItem, SlackCanvasItem, SlackPinItem } from "./project.js";

/** A non-empty string field off an unknown, or undefined. Pure. */
function str({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Slack decimal ts (`epochSeconds.micros`) → ISO-8601, or "" when unparseable. Pure. */
function tsToIso({ ts }: { ts: string }): string {
  const seconds = Number(ts.split(".")[0]);
  return Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : "";
}

/** A stable message permalink (`<workspaceUrl>/archives/<channel>/p<ts>`), the citation for a pin. Pure. */
export function slackPermalink({
  workspaceUrl,
  channelId,
  ts,
}: {
  workspaceUrl: string;
  channelId: string;
  ts: string;
}): string {
  return `${workspaceUrl}/archives/${channelId}/p${ts.replace(".", "")}`;
}

/**
 * Shape one raw `pins.list` item (a pinned message) into a {@link SlackPinItem}, or undefined for a
 * non-message / ts-less pin. Pure.
 *
 * @param item the raw pin item
 * @param channelId the channel the pin belongs to
 * @param channelName the channel's display name (optional)
 * @param workspaceUrl the workspace base url (for the permalink)
 * @param authorName the resolved display name of the message author (optional)
 * @returns the shaped pin, or undefined
 */
export function shapePin({
  item,
  channelId,
  channelName,
  workspaceUrl,
  authorName,
}: {
  item: unknown;
  channelId: string;
  channelName?: string;
  workspaceUrl: string;
  authorName?: string;
}): SlackPinItem | undefined {
  const message = isRecord(item) && isRecord(item["message"]) ? item["message"] : undefined;
  const ts = message !== undefined ? str({ value: message["ts"] }) : undefined;
  if (message === undefined || ts === undefined) {
    return undefined; // a non-message pin (e.g. a file pin) is skipped — messages carry the curated signal
  }
  const permalink = str({ value: message["permalink"] }) ?? slackPermalink({ channelId, ts, workspaceUrl });
  const text = str({ value: message["text"] });
  return {
    channelId,
    permalink,
    raw: message,
    ts,
    tsIso: tsToIso({ ts }),
    ...(channelName !== undefined ? { channelName } : {}),
    ...(text !== undefined ? { text } : {}),
    ...(authorName !== undefined ? { author: authorName } : {}),
  };
}

/**
 * Shape one raw `bookmarks.list` bookmark into a {@link SlackBookmarkItem}, or undefined for a link-less
 * one. Pure.
 *
 * @param raw the raw bookmark object
 * @param channelId the channel the bookmark belongs to
 * @param channelName the channel's display name (optional)
 * @returns the shaped bookmark, or undefined
 */
export function shapeBookmark({
  raw,
  channelId,
  channelName,
}: {
  raw: unknown;
  channelId: string;
  channelName?: string;
}): SlackBookmarkItem | undefined {
  const id = isRecord(raw) ? str({ value: raw["id"] }) : undefined;
  const link = isRecord(raw) ? str({ value: raw["link"] }) : undefined;
  if (id === undefined || link === undefined || !isRecord(raw)) {
    return undefined;
  }
  const dateMs = typeof raw["date_created"] === "number" ? raw["date_created"] * 1000 : undefined;
  return {
    channelId,
    id,
    link,
    raw,
    title: str({ value: raw["title"] }) ?? link,
    tsIso: dateMs !== undefined ? new Date(dateMs).toISOString() : "",
    ...(channelName !== undefined ? { channelName } : {}),
  };
}

/** Whether a raw `files.list` file is a canvas (the durable canvas discovery path). Pure. */
export function isCanvasFile({ file }: { file: unknown }): boolean {
  if (!isRecord(file)) {
    return false;
  }
  return (
    file["filetype"] === "canvas" || file["mode"] === "canvas" || file["mimetype"] === "application/vnd.slack-docs"
  );
}

/**
 * Shape one raw `files.list` canvas file into a ref-only {@link SlackCanvasItem}, or undefined for a
 * non-canvas / id-less file. NEVER persists `url_private` (a signed, expiring URL). Pure.
 *
 * @param file the raw file object
 * @returns the shaped canvas, or undefined
 */
export function shapeCanvasFile({ file }: { file: unknown }): SlackCanvasItem | undefined {
  if (!isCanvasFile({ file }) || !isRecord(file)) {
    return undefined;
  }
  const id = str({ value: file["id"] });
  const permalink = str({ value: file["permalink"] });
  if (id === undefined || permalink === undefined) {
    return undefined; // no id or no public permalink — nothing safe to cite
  }
  const createdMs = typeof file["created"] === "number" ? file["created"] * 1000 : undefined;
  const channelId =
    Array.isArray(file["channels"]) && typeof file["channels"][0] === "string" ? file["channels"][0] : undefined;
  return {
    id,
    permalink,
    raw: file,
    title: str({ value: file["title"] }) ?? str({ value: file["name"] }) ?? `Canvas ${id}`,
    tsIso: createdMs !== undefined ? new Date(createdMs).toISOString() : "",
    ...(channelId !== undefined ? { channelId } : {}),
  };
}
