/**
 * `/api/calibration` response builder. Reads the walk-feedback JSONL
 * log written by `log_walk_feedback` (PR #54) at
 * `<data-dir>/.claude/personal/state/lock-in-feedback.jsonl` — or
 * wherever the SLOPWEAVER_FEEDBACK_LOG env var points — and aggregates
 * a calibration report consumable by the dashboard's chart tab.
 *
 * Missing log → all-zeros response, no error. That's the right
 * default for users who haven't run a /lock-in walk yet.
 *
 * Pure-ish: file IO + JSON parsing. Returns a Result-shaped response
 * via try/catch (the UI server uses throwing semantics — same pattern
 * as the existing diagnostics endpoint).
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_RELATIVE_PATH = '.claude/personal/state/lock-in-feedback.jsonl';
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export type CalibrationPoint = {
  /** ISO day, e.g. "2026-05-21". */
  day: string;
  approved: number;
  edited: number;
  rejected: number;
  deferred: number;
  dropped: number;
  noted: number;
};

export type FrictionTagTally = {
  tag: string;
  count: number;
};

export type CalibrationResponse = {
  window_start: string;
  window_end: string;
  total_walks: number;
  total_items: number;
  acceptance_rate: number;
  edit_rate: number;
  rejection_rate: number;
  /** One bucket per day in the window. Empty days fill with zeros. */
  daily: ReadonlyArray<CalibrationPoint>;
  /** Top 10 friction tags by count. */
  top_friction_tags: ReadonlyArray<FrictionTagTally>;
  /** Effective JSONL path the response was built from. */
  source_path: string;
  /** True when the log was readable; false when missing (response is all-zeros). */
  source_present: boolean;
  generated_at: string;
};

export type BuildCalibrationArgs = {
  /** Absolute path to the JSONL log. Required (the UI server resolves this against the data dir). */
  logPath: string;
  /** Window cutoff. Defaults to 30 days back from `now`. */
  sinceMs?: number;
  /** Clock injection (tests). */
  nowMs?: number;
};

export function buildCalibrationResponse(args: BuildCalibrationArgs): CalibrationResponse {
  const nowMs = args.nowMs ?? Date.now();
  const sinceMs = args.sinceMs ?? nowMs - THIRTY_DAYS_MS;

  let content: string | null;
  try {
    content = readFileSync(args.logPath, 'utf-8');
  } catch {
    content = null;
  }

  if (content === null) {
    return emptyResponse({ logPath: args.logPath, sinceMs, nowMs, sourcePresent: false });
  }

  // Map JSONL outcome strings → the numeric-tile name. The
  // `approved-as-proposed` outcome maps to the `approved` tile; the
  // other five outcomes share names with their tiles. `walk-summary`
  // is intentionally absent — those lines contribute to `walks` but
  // not to per-item counts.
  const OUTCOME_TO_TILE: Record<string, 'approved' | 'edited' | 'rejected' | 'deferred' | 'dropped' | 'noted'> = {
    'approved-as-proposed': 'approved',
    edited: 'edited',
    rejected: 'rejected',
    deferred: 'deferred',
    dropped: 'dropped',
    noted: 'noted',
  };
  const counts = { approved: 0, edited: 0, rejected: 0, deferred: 0, dropped: 0, noted: 0 };
  const walks = new Set<string>();
  const tags = new Map<string, number>();
  const daily = new Map<string, CalibrationPoint>();

  for (const raw of content.split('\n')) {
    if (raw.trim().length === 0) continue;
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(raw) as unknown;
      if (typeof value !== 'object' || value === null) continue;
      parsed = value as Record<string, unknown>;
    } catch {
      continue;
    }
    const ts = parsed['ts'];
    const walkId = parsed['walk_id'];
    const outcome = parsed['outcome'];
    if (typeof ts !== 'string' || typeof walkId !== 'string' || typeof outcome !== 'string') continue;
    const lineMs = Date.parse(ts);
    if (!Number.isFinite(lineMs) || lineMs < sinceMs) continue;

    walks.add(walkId);
    const tile = OUTCOME_TO_TILE[outcome];
    if (tile !== undefined) {
      counts[tile] += 1;
      const day = ts.slice(0, 10); // YYYY-MM-DD
      bumpDaily({ daily, day, tile });
    }
    if (Array.isArray(parsed['tags'])) {
      for (const tag of parsed['tags']) {
        if (typeof tag === 'string' && tag.startsWith('friction:')) {
          tags.set(tag, (tags.get(tag) ?? 0) + 1);
        }
      }
    }
  }

  const totalItems = Object.values(counts).reduce((a, b) => a + b, 0);
  const rate = (n: number): number => (totalItems === 0 ? 0 : n / totalItems);

  return {
    window_start: new Date(sinceMs).toISOString(),
    window_end: new Date(nowMs).toISOString(),
    total_walks: walks.size,
    total_items: totalItems,
    acceptance_rate: rate(counts.approved),
    edit_rate: rate(counts.edited),
    rejection_rate: rate(counts.rejected),
    daily: [...daily.values()].sort((a, b) => a.day.localeCompare(b.day)),
    top_friction_tags: [...tags.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 10),
    source_path: args.logPath,
    source_present: true,
    generated_at: new Date(nowMs).toISOString(),
  };
}

function bumpDaily({
  daily,
  day,
  tile,
}: {
  daily: Map<string, CalibrationPoint>;
  day: string;
  tile: 'approved' | 'edited' | 'rejected' | 'deferred' | 'dropped' | 'noted';
}): void {
  let point = daily.get(day);
  if (point === undefined) {
    point = { day, approved: 0, edited: 0, rejected: 0, deferred: 0, dropped: 0, noted: 0 };
    daily.set(day, point);
  }
  point[tile] += 1;
}

function emptyResponse(args: {
  logPath: string;
  sinceMs: number;
  nowMs: number;
  sourcePresent: boolean;
}): CalibrationResponse {
  return {
    window_start: new Date(args.sinceMs).toISOString(),
    window_end: new Date(args.nowMs).toISOString(),
    total_walks: 0,
    total_items: 0,
    acceptance_rate: 0,
    edit_rate: 0,
    rejection_rate: 0,
    daily: [],
    top_friction_tags: [],
    source_path: args.logPath,
    source_present: args.sourcePresent,
    generated_at: new Date(args.nowMs).toISOString(),
  };
}

/**
 * Convenience: build the canonical log path from a working directory.
 * Mirrors where `log_walk_feedback` (PR #54) writes by default. Used
 * by the UI server when starting up — it has access to `cwd` because
 * the MCP server launches it in-process.
 */
export function defaultCalibrationLogPath({ cwd }: { cwd: string }): string {
  return join(cwd, DEFAULT_RELATIVE_PATH);
}
