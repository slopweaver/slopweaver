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
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

export type CalibrationPoint = {
  /** ISO day (UTC), e.g. "2026-05-21". */
  day: string;
  approved: number;
  edited: number;
  rejected: number;
  deferred: number;
  dropped: number;
  noted: number;
  /** Total of all outcomes on the day (sum of the six counts above). */
  total: number;
  /** Ratio of approved over `total`, or 0 when `total === 0`. */
  accept_ratio: number;
  /** Ratio of edited over `total`, or 0 when `total === 0`. */
  edit_ratio: number;
  /** Ratio of rejected over `total`, or 0 when `total === 0`. */
  reject_ratio: number;
};

export type FrictionTagTally = {
  tag: string;
  count: number;
};

export type CalibrationBreakdown = {
  /** Either the integration slug (e.g. `"github"`) or the kind (e.g. `"review_request"`). Falls back to `"unknown"` when the line lacks the field. */
  key: string;
  /** Count of `approved-as-proposed` outcomes. */
  accept: number;
  /** Count of `edited` outcomes. */
  edit: number;
  /** Count of `rejected` outcomes. */
  reject: number;
};

export type CalibrationResponse = {
  window_start: string;
  window_end: string;
  total_walks: number;
  total_items: number;
  acceptance_rate: number;
  edit_rate: number;
  rejection_rate: number;
  /**
   * One bucket per day in the window, zero-filled. Spans `window_start`
   * → `window_end` on a UTC-day basis, ascending.
   */
  daily: ReadonlyArray<CalibrationPoint>;
  /** Per-integration accept/edit/reject counts. */
  by_integration: ReadonlyArray<CalibrationBreakdown>;
  /** Per-kind accept/edit/reject counts (`kind` field on the feedback line). */
  by_kind: ReadonlyArray<CalibrationBreakdown>;
  /** Top 10 friction tags by count. */
  top_friction_tags: ReadonlyArray<FrictionTagTally>;
  /** Effective JSONL path the response was built from. */
  source_path: string;
  /** True when the log was readable; false when missing (response is all-zeros). */
  source_present: boolean;
  /** True when the response carries no walks/items — useful for the empty-state UI. */
  empty: boolean;
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
  const dailySkeleton = buildDailySkeleton({ sinceMs, nowMs });

  let content: string | null;
  try {
    content = readFileSync(args.logPath, 'utf-8');
  } catch {
    content = null;
  }

  if (content === null) {
    return emptyResponse({
      logPath: args.logPath,
      sinceMs,
      nowMs,
      sourcePresent: false,
      dailySkeleton,
    });
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
  const daily = new Map<string, CalibrationPoint>(dailySkeleton.map((p) => [p.day, p]));
  const byIntegration = new Map<string, CalibrationBreakdown>();
  const byKind = new Map<string, CalibrationBreakdown>();

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
    if (!Number.isFinite(lineMs) || lineMs < sinceMs || lineMs > nowMs) continue;

    walks.add(walkId);
    const tile = OUTCOME_TO_TILE[outcome];
    if (tile !== undefined) {
      counts[tile] += 1;
      const day = toUtcDay({ ms: lineMs });
      bumpDaily({ daily, day, tile });

      // Only the three "headline" outcomes feed the breakdown tables —
      // matches the breakdown contract (accept/edit/reject).
      const breakdownTile: 'accept' | 'edit' | 'reject' | null =
        tile === 'approved' ? 'accept' : tile === 'edited' ? 'edit' : tile === 'rejected' ? 'reject' : null;
      if (breakdownTile !== null) {
        const integrationKey = typeof parsed['integration'] === 'string' ? parsed['integration'] : 'unknown';
        const kindKey = typeof parsed['kind'] === 'string' ? parsed['kind'] : 'unknown';
        bumpBreakdown({ map: byIntegration, key: integrationKey, tile: breakdownTile });
        bumpBreakdown({ map: byKind, key: kindKey, tile: breakdownTile });
      }
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
    daily: dailySkeleton.map((p) => finalizeDailyPoint({ point: daily.get(p.day) ?? p })),
    by_integration: sortBreakdown({ map: byIntegration }),
    by_kind: sortBreakdown({ map: byKind }),
    top_friction_tags: [...tags.entries()]
      .map(([tag, count]) => ({ tag, count }))
      .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 10),
    source_path: args.logPath,
    source_present: true,
    empty: totalItems === 0 && walks.size === 0,
    generated_at: new Date(nowMs).toISOString(),
  };
}

/**
 * Build a contiguous, zero-filled array of `CalibrationPoint`s spanning
 * `sinceMs` → `nowMs` on a UTC-day basis (inclusive on both ends). Used
 * as the daily skeleton so empty days render as gaps rather than holes.
 */
function buildDailySkeleton({ sinceMs, nowMs }: { sinceMs: number; nowMs: number }): CalibrationPoint[] {
  const points: CalibrationPoint[] = [];
  // Anchor both endpoints to UTC midnight so daylight-savings shifts on
  // the host clock don't shorten/lengthen the series.
  const startMs = utcMidnight({ ms: Math.min(sinceMs, nowMs) });
  const endMs = utcMidnight({ ms: Math.max(sinceMs, nowMs) });
  for (let dayMs = startMs; dayMs <= endMs; dayMs += ONE_DAY_MS) {
    points.push({
      day: toUtcDay({ ms: dayMs }),
      approved: 0,
      edited: 0,
      rejected: 0,
      deferred: 0,
      dropped: 0,
      noted: 0,
      total: 0,
      accept_ratio: 0,
      edit_ratio: 0,
      reject_ratio: 0,
    });
  }
  return points;
}

function utcMidnight({ ms }: { ms: number }): number {
  const d = new Date(ms);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function toUtcDay({ ms }: { ms: number }): string {
  // ISO 8601 'YYYY-MM-DD' from a Date's UTC fields — robust against
  // host-local DST flips (which `ts.slice(0,10)` would otherwise inherit
  // if a producer ever writes a non-`Z` offset).
  const d = new Date(ms);
  const y = d.getUTCFullYear().toString().padStart(4, '0');
  const m = (d.getUTCMonth() + 1).toString().padStart(2, '0');
  const day = d.getUTCDate().toString().padStart(2, '0');
  return `${y}-${m}-${day}`;
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
    // An event whose UTC day falls outside the skeleton can't happen in
    // practice (we already filtered by sinceMs/nowMs upstream), but be
    // defensive — drop a fresh bucket in.
    point = {
      day,
      approved: 0,
      edited: 0,
      rejected: 0,
      deferred: 0,
      dropped: 0,
      noted: 0,
      total: 0,
      accept_ratio: 0,
      edit_ratio: 0,
      reject_ratio: 0,
    };
    daily.set(day, point);
  }
  point[tile] += 1;
}

function finalizeDailyPoint({ point }: { point: CalibrationPoint }): CalibrationPoint {
  const total = point.approved + point.edited + point.rejected + point.deferred + point.dropped + point.noted;
  const ratio = (n: number): number => (total === 0 ? 0 : n / total);
  return {
    ...point,
    total,
    accept_ratio: ratio(point.approved),
    edit_ratio: ratio(point.edited),
    reject_ratio: ratio(point.rejected),
  };
}

function bumpBreakdown({
  map,
  key,
  tile,
}: {
  map: Map<string, CalibrationBreakdown>;
  key: string;
  tile: 'accept' | 'edit' | 'reject';
}): void {
  let row = map.get(key);
  if (row === undefined) {
    row = { key, accept: 0, edit: 0, reject: 0 };
    map.set(key, row);
  }
  row[tile] += 1;
}

function sortBreakdown({ map }: { map: Map<string, CalibrationBreakdown> }): CalibrationBreakdown[] {
  return [...map.values()].sort((a, b) => {
    const aTotal = a.accept + a.edit + a.reject;
    const bTotal = b.accept + b.edit + b.reject;
    return bTotal - aTotal || a.key.localeCompare(b.key);
  });
}

function emptyResponse(args: {
  logPath: string;
  sinceMs: number;
  nowMs: number;
  sourcePresent: boolean;
  dailySkeleton: ReadonlyArray<CalibrationPoint>;
}): CalibrationResponse {
  return {
    window_start: new Date(args.sinceMs).toISOString(),
    window_end: new Date(args.nowMs).toISOString(),
    total_walks: 0,
    total_items: 0,
    acceptance_rate: 0,
    edit_rate: 0,
    rejection_rate: 0,
    daily: args.dailySkeleton,
    by_integration: [],
    by_kind: [],
    top_friction_tags: [],
    source_path: args.logPath,
    source_present: args.sourcePresent,
    empty: true,
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

/**
 * Resolve the effective JSONL log path for the UI server. The
 * `SLOPWEAVER_FEEDBACK_LOG` env var, when set, takes precedence over the
 * default-from-cwd location. Both an explicit `feedbackLogPath` override
 * (e.g. from a CLI flag) and the env var are checked; the override wins
 * when supplied.
 */
export function resolveCalibrationLogPath({
  feedbackLogPath,
  env,
  cwd,
}: {
  feedbackLogPath: string | undefined;
  env: NodeJS.ProcessEnv;
  cwd: string;
}): string {
  if (feedbackLogPath !== undefined && feedbackLogPath.length > 0) return feedbackLogPath;
  const fromEnv = env['SLOPWEAVER_FEEDBACK_LOG'];
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return defaultCalibrationLogPath({ cwd });
}
