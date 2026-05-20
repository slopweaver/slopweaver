/**
 * Walk-feedback log helpers. Each `/lock-in` walk emits a JSONL line per
 * item plus one walk-summary line on stop. This module owns the append
 * (used by `log_walk_feedback`) and the read-and-aggregate (used by
 * `get_calibration_report`).
 *
 * The log lives at a configurable path (default
 * `.claude/personal/state/lock-in-feedback.jsonl`) under the user's cwd.
 * Parent dirs are created on demand. Lines are JSON objects with a stable
 * schema mirrored from ev-admin's `/lock-in` doc.
 */

import { readFile } from 'node:fs/promises';
import { type ResultAsync, type Result, err, ok } from '@slopweaver/errors';
import { type WorkConsoleError, WorkConsoleErrors } from './errors.ts';
import { safeAppendJsonl, wrapResultPromise } from './files.ts';

export type WalkFeedbackOutcome =
  | 'approved-as-proposed'
  | 'edited'
  | 'rejected'
  | 'deferred'
  | 'dropped'
  | 'noted'
  | 'walk-summary';

export type WalkFeedbackLine = {
  ts: string;
  walk_id: string;
  item_index: number;
  item_anchor?: string;
  item_source?: string;
  item_summary?: string;
  proposed_action?: string;
  user_action?: string;
  outcome: WalkFeedbackOutcome;
  user_text?: string | null;
  edit_diff?: string | null;
  tags?: ReadonlyArray<string>;
  totals?: WalkFeedbackTotals;
  duration_minutes?: number;
};

export type WalkFeedbackTotals = {
  items: number;
  approved: number;
  edited: number;
  rejected: number;
  deferred: number;
  dropped: number;
  noted: number;
};

export type AppendFeedbackArgs = {
  absLogPath: string;
  line: Omit<WalkFeedbackLine, 'ts'> & { ts?: string };
  now?: () => Date;
  /** Convert a single line of feedback to JSON. Override only in tests. */
  stringify?: (line: WalkFeedbackLine) => string;
};

export type AppendFeedbackResult = {
  absolutePath: string;
  lineNumber: number;
  bytesAppended: number;
};

const describeIo = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function countExistingLines(absLogPath: string): Promise<Result<number, WorkConsoleError>> {
  try {
    const content = await readFile(absLogPath, 'utf-8');
    return ok(content.split('\n').filter((l) => l.trim().length > 0).length);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return ok(0);
    return err(WorkConsoleErrors.io(absLogPath, 'read', describeIo(e)));
  }
}

/**
 * Append one walk-feedback line. The line number returned is the 1-based
 * index of the new line in the file *after* this append, computed by
 * counting trailing newlines in the file before the append + 1.
 */
export function appendFeedbackLine(args: AppendFeedbackArgs): ResultAsync<AppendFeedbackResult, WorkConsoleError> {
  const now = args.now ?? (() => new Date());
  const stringify = args.stringify ?? ((line) => JSON.stringify(line));
  const ts = args.line.ts ?? now().toISOString();
  const fullLine: WalkFeedbackLine = { ...args.line, ts };
  const json = stringify(fullLine);

  return wrapResultPromise(countExistingLines(args.absLogPath)).andThen<AppendFeedbackResult, WorkConsoleError>(
    (existingLines) =>
      safeAppendJsonl(args.absLogPath, json).map((appendOk) => ({
        absolutePath: appendOk.absolutePath,
        lineNumber: existingLines + 1,
        bytesAppended: appendOk.bytesAppended,
      })),
  );
}

export type CalibrationSummary = {
  windowStartIso: string;
  windowEndIso: string;
  totalWalks: number;
  totalItems: number;
  outcomeCounts: {
    'approved-as-proposed': number;
    edited: number;
    rejected: number;
    deferred: number;
    dropped: number;
    noted: number;
  };
  acceptanceRate: number;
  editRate: number;
  rejectionRate: number;
  topFrictionTags: ReadonlyArray<{ tag: string; count: number }>;
};

export type LoadAndSummarizeArgs = {
  absLogPath: string;
  sinceIso?: string;
  now?: () => Date;
};

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function loadAndSummarizeImpl(args: LoadAndSummarizeArgs): Promise<Result<CalibrationSummary, WorkConsoleError>> {
  const now = args.now ?? (() => new Date());
  const nowDate = now();
  const sinceMs = args.sinceIso != null ? Date.parse(args.sinceIso) : nowDate.getTime() - THIRTY_DAYS_MS;
  let content: string;
  try {
    content = await readFile(args.absLogPath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok(emptySummary(new Date(sinceMs), nowDate));
    }
    return err(WorkConsoleErrors.io(args.absLogPath, 'read', describeIo(e)));
  }
  return ok(summarize(content, sinceMs, nowDate));
}

/**
 * Read the full JSONL log, filter to lines at-or-after `since`, and return
 * a {@link CalibrationSummary}. Missing log returns an empty summary —
 * callers should treat that as "no walks logged yet".
 */
export function loadAndSummarize(args: LoadAndSummarizeArgs): ResultAsync<CalibrationSummary, WorkConsoleError> {
  return wrapResultPromise(loadAndSummarizeImpl(args));
}

function emptySummary(start: Date, end: Date): CalibrationSummary {
  return {
    windowStartIso: start.toISOString(),
    windowEndIso: end.toISOString(),
    totalWalks: 0,
    totalItems: 0,
    outcomeCounts: {
      'approved-as-proposed': 0,
      edited: 0,
      rejected: 0,
      deferred: 0,
      dropped: 0,
      noted: 0,
    },
    acceptanceRate: 0,
    editRate: 0,
    rejectionRate: 0,
    topFrictionTags: [],
  };
}

function summarize(content: string, sinceMs: number, nowDate: Date): CalibrationSummary {
  const lines = content.split('\n').filter((l) => l.trim().length > 0);
  const walkIds = new Set<string>();
  const itemOutcomes = {
    'approved-as-proposed': 0,
    edited: 0,
    rejected: 0,
    deferred: 0,
    dropped: 0,
    noted: 0,
  };
  const frictionTagCounts = new Map<string, number>();

  for (const rawLine of lines) {
    const parsed = safeParseLine(rawLine);
    if (parsed === null) continue;
    const lineMs = Date.parse(parsed.ts);
    if (Number.isFinite(lineMs) && lineMs < sinceMs) continue;
    walkIds.add(parsed.walk_id);
    if (parsed.outcome === 'walk-summary') continue;
    // TS narrows `parsed.outcome` to the non-walk-summary union here,
    // matching the keys defined on `itemOutcomes` — no cast required.
    itemOutcomes[parsed.outcome] += 1;
    if (Array.isArray(parsed.tags)) {
      for (const tag of parsed.tags) {
        if (typeof tag === 'string' && tag.startsWith('friction:')) {
          frictionTagCounts.set(tag, (frictionTagCounts.get(tag) ?? 0) + 1);
        }
      }
    }
  }

  const totalItems = Object.values(itemOutcomes).reduce((a, b) => a + b, 0);
  const ratio = (numerator: number): number => (totalItems === 0 ? 0 : numerator / totalItems);

  const topFrictionTags = [...frictionTagCounts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag))
    .slice(0, 10);

  return {
    windowStartIso: new Date(sinceMs).toISOString(),
    windowEndIso: nowDate.toISOString(),
    totalWalks: walkIds.size,
    totalItems,
    outcomeCounts: itemOutcomes,
    acceptanceRate: ratio(itemOutcomes['approved-as-proposed']),
    editRate: ratio(itemOutcomes['edited']),
    rejectionRate: ratio(itemOutcomes['rejected']),
    topFrictionTags,
  };
}

const VALID_OUTCOMES: ReadonlySet<WalkFeedbackOutcome> = new Set([
  'approved-as-proposed',
  'edited',
  'rejected',
  'deferred',
  'dropped',
  'noted',
  'walk-summary',
]);

function safeParseLine(raw: string): WalkFeedbackLine | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const obj = parsed as Record<string, unknown>;
  const ts = obj['ts'];
  const walkId = obj['walk_id'];
  const itemIndex = obj['item_index'];
  const outcomeRaw = obj['outcome'];
  if (typeof ts !== 'string') return null;
  if (typeof walkId !== 'string') return null;
  if (typeof itemIndex !== 'number') return null;
  if (typeof outcomeRaw !== 'string') return null;
  if (!VALID_OUTCOMES.has(outcomeRaw as WalkFeedbackOutcome)) return null;
  // Build a concrete value with only the fields we've validated.
  // Additional optional fields are forwarded as-is from the parsed object.
  return {
    ts,
    walk_id: walkId,
    item_index: itemIndex,
    outcome: outcomeRaw as WalkFeedbackOutcome,
    ...(typeof obj['item_anchor'] === 'string' && { item_anchor: obj['item_anchor'] }),
    ...(typeof obj['item_source'] === 'string' && { item_source: obj['item_source'] }),
    ...(typeof obj['item_summary'] === 'string' && { item_summary: obj['item_summary'] }),
    ...(typeof obj['proposed_action'] === 'string' && { proposed_action: obj['proposed_action'] }),
    ...(typeof obj['user_action'] === 'string' && { user_action: obj['user_action'] }),
    ...(Array.isArray(obj['tags']) && {
      tags: (obj['tags'] as ReadonlyArray<unknown>).filter((t): t is string => typeof t === 'string'),
    }),
  };
}
