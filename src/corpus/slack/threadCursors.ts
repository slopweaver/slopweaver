/**
 * Per-thread incremental reply cursors — a durable `channel:threadTs → last-seen reply ts` map so a
 * refresh re-reads only NEW thread replies instead of re-pulling every thread's full history each
 * window. Kept SEPARATE from the source-level watermark (a thread can gain a reply long after the
 * parent message's timestamp, which the source watermark alone would miss).
 *
 * Pure core (`threadKey` / `newerReplies` / `latestReplyTs`) is unit-tested; the read/write edge
 * persists `$SLOPWEAVER_HOME/corpus/.slack-threads.json` atomically. This is a sanctioned local-state
 * seam (see `src/admit/coverage.ts`). NOTE: this is only the INGEST cursor — the owed/attention-queue
 * semantics (human-vs-bot, dismissed, notify) are deliberately NOT here; they belong to the operator loop.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { slopweaverHome } from "../../config.js";
import { isRecord } from "../../lib/parsers.js";
import { err, ok, type Result } from "../../lib/result.js";
import { stateHomePaths } from "../../stateHome.js";

/** `channel:threadTs → last-seen reply ts`. */
export type ThreadCursors = Readonly<Record<string, string>>;

/** The store key for one thread. */
export function threadKey({ channel, threadTs }: { channel: string; threadTs: string }): string {
  return `${channel}:${threadTs}`;
}

/** Replies strictly newer than `afterTs` (undefined ⇒ all) — drops the inclusive-boundary re-fetch. */
export function newerReplies<T extends { readonly ts: string }>({
  replies,
  afterTs,
}: {
  replies: readonly T[];
  afterTs: string | undefined;
}): readonly T[] {
  if (afterTs === undefined) {
    return replies;
  }
  return replies.filter((reply) => Number(reply.ts) > Number(afterTs));
}

/** The newest reply ts (numeric max) across `replies` + the `current` cursor — the next stored cursor. */
export function latestReplyTs({
  current,
  replies,
}: {
  current: string | undefined;
  replies: readonly { readonly ts: string }[];
}): string | undefined {
  let best = current;
  for (const reply of replies) {
    if (best === undefined || Number(reply.ts) > Number(best)) {
      best = reply.ts;
    }
  }
  return best;
}

/**
 * Read the persisted thread cursors. Any unreadable/unrecognised file degrades to an empty map.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the stored cursors, or `{}` when none
 */
export function readThreadCursors({ home = slopweaverHome() }: { home?: string } = {}): ThreadCursors {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(stateHomePaths({ home }).corpus.slackThreads, "utf8"));
  } catch {
    return {};
  }
  if (!isRecord(raw)) {
    return {};
  }
  const cursors: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value === "string" && value.length > 0) {
      cursors[key] = value;
    }
  }
  return cursors;
}

/**
 * Persist the thread cursors atomically (tmp + rename).
 *
 * @param cursors the full cursor map to write
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the written path, or an error on write failure
 */
export function writeThreadCursors({
  cursors,
  home = slopweaverHome(),
}: {
  cursors: ThreadCursors;
  home?: string;
}): Result<{ path: string }> {
  const path = stateHomePaths({ home }).corpus.slackThreads;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(cursors, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error: unknown) {
    return err([error instanceof Error ? error.message : `failed to write ${path}`]);
  }
  return ok({ path });
}
