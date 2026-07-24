/**
 * The best-effort curated-surface fetch for Slack (pins + bookmarks per channel, canvases workspace-wide).
 * Split out of `fetch.ts` (which stays under the file-size ceiling); every lane here is optional — a missing
 * method or a scope gap warns + skips, so the curated pass NEVER sinks the message crawl. Ref-only.
 *
 * Pins/bookmarks are Slack Tier-2 rate-limited, so they run ONLY for the few most-active channels (a pin is
 * most likely to matter where the conversation is); the uncapped message crawl in `fetch.ts` is the content
 * that matters.
 */

import { collectCursorPages } from "../../lib/paging.js";
import { isRecord } from "../../lib/parsers.js";
import { shapeBookmark, shapeCanvasFile, shapePin } from "./curated.js";
import type { SlackApi } from "./fetch.js";
import type {
  SlackBookmarkItem,
  SlackCanvasItem,
  SlackChannelItems,
  SlackCuratedItems,
  SlackNameMaps,
  SlackPinItem,
} from "./project.js";

/** At most this many of the most-active channels get a curated pins/bookmarks fetch (Tier-2 rate cap). */
const CURATED_PIN_CHANNEL_CAP = 10;

/**
 * Rank crawled channels by activity (messages + replies), most active first, as `{id, name?}`. Used to pick
 * the handful of channels worth a curated pins/bookmarks fetch. Pure.
 *
 * @param channels the crawled per-channel items
 * @returns the channels as `{id, name?}`, most-active first
 */
export function rankChannelsByActivity({
  channels,
}: {
  channels: readonly {
    channelId: string;
    channelName?: string;
    messages: readonly unknown[];
    replies: readonly unknown[];
  }[];
}): readonly { id: string; name?: string }[] {
  return [...channels]
    .toSorted((a, b) => b.messages.length + b.replies.length - (a.messages.length + a.replies.length))
    .map((c) => (c.channelName !== undefined ? { id: c.channelId, name: c.channelName } : { id: c.channelId }));
}

/** The resolved display name of a pinned message's author (via the user map), or undefined. Pure. */
function pinAuthor({ item, maps }: { item: unknown; maps: SlackNameMaps }): string | undefined {
  const message = isRecord(item) && isRecord(item["message"]) ? item["message"] : undefined;
  const user = message !== undefined && typeof message["user"] === "string" ? message["user"] : undefined;
  return user !== undefined ? maps.userNames[user] : undefined;
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

/**
 * Gather the curated Slack surfaces best-effort: pins + bookmarks for the most-active channels (ranked +
 * capped here), and canvases via a workspace-wide `files.list`. Every lane is optional (a missing method or
 * a scope gap warns + skips), so this NEVER sinks the message crawl. Ref-only throughout.
 *
 * @param api the injected Slack seam
 * @param channels the crawled per-channel items (ranked here to pick the pin/bookmark targets)
 * @param workspaceUrl the workspace base URL (for permalinks)
 * @param maps the id→name maps (to resolve pin authors)
 * @returns the curated items + best-effort warnings
 */
export async function fetchSlackCurated({
  api,
  channels,
  workspaceUrl,
  maps,
}: {
  api: SlackApi;
  channels: readonly SlackChannelItems[];
  workspaceUrl: string;
  maps: SlackNameMaps;
}): Promise<{ items: SlackCuratedItems; warnings: readonly string[] }> {
  const selected = rankChannelsByActivity({ channels }).slice(0, CURATED_PIN_CHANNEL_CAP);
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
