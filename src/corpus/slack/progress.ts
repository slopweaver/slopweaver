/**
 * The pure Slack-crawl progress helpers (PR4.4c) — titles, per-channel counts, a first-message preview,
 * and the running-totals accumulator the crawl folds each channel into. Kept beside the Slack edge but in
 * their own file so `fetch.ts` stays under the file-size ceiling; every function here is pure (or a thin
 * fire-and-forget emit) and unit-tested.
 */

import { type SourceProgress, type SourceProgressEvent, sourceHeartbeat, sourcePreview } from "../progress.js";
import type { SlackChannelItems } from "./project.js";

/** The heartbeat title for a channel — `#name` when known, else the raw id. Pure. */
export function slackChannelTitle({ channel }: { channel: { id: string; name?: string } }): string {
  return channel.name !== undefined ? `#${channel.name}` : channel.id;
}

/** The per-channel counts (messages + distinct threads) from one channel's shaped items. Pure. */
export function slackChannelCounts({ items }: { items: SlackChannelItems }): { messages: number; threads: number } {
  return { messages: items.messages.length, threads: new Set(items.replies.map((reply) => reply.threadTs)).size };
}

/** A content-preview event from a channel's first message with text, or undefined when it has none. Pure. */
export function slackChannelPreview({
  channel,
  items,
}: {
  channel: { id: string; name?: string };
  items: SlackChannelItems;
}): SourceProgressEvent | undefined {
  const first = items.messages.find((message) => message.text !== undefined && message.text.length > 0);
  if (first?.text === undefined) {
    return undefined;
  }
  return sourcePreview({
    phase: "channel",
    snippet: first.text,
    source: "slack",
    sourceContentId: channel.id,
    subject: slackChannelTitle({ channel }),
  });
}

/** A mutable running-totals accumulator for the Slack crawl's heartbeat metrics. */
export interface SlackCrawlTotals {
  messages: number;
  threads: number;
  skipped: number;
}

/** Emit the pre-fetch "starting this channel" heartbeat (names the channel + its position). */
export function startChannelHeartbeat({
  channel,
  index,
  total,
  onProgress,
}: {
  channel: { id: string; name?: string };
  index: number;
  total: number;
  onProgress: SourceProgress | undefined;
}): void {
  onProgress?.(
    sourceHeartbeat({
      currentItem: { title: slackChannelTitle({ channel }) },
      done: index,
      phase: "channel",
      source: "slack",
      total,
    }),
  );
}

/** Fold one crawled channel's counts into the running totals + emit its preview and a `done` heartbeat. */
export function absorbChannelProgress({
  channel,
  index,
  items,
  total,
  totals,
  onProgress,
}: {
  channel: { id: string; name?: string };
  index: number;
  items: SlackChannelItems;
  total: number;
  totals: SlackCrawlTotals;
  onProgress: SourceProgress | undefined;
}): void {
  const counts = slackChannelCounts({ items });
  totals.messages += counts.messages;
  totals.threads += counts.threads;
  const preview = slackChannelPreview({ channel, items });
  if (preview !== undefined) {
    onProgress?.(preview);
  }
  onProgress?.(
    sourceHeartbeat({
      done: index + 1,
      metrics: { messages: totals.messages, skipped: totals.skipped, threads: totals.threads },
      phase: "channel",
      source: "slack",
      total,
    }),
  );
}
