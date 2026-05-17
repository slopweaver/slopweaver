/**
 * Composite `start_session` tool — the v1 flagship.
 *
 * Answers "what should I work on next?" by reading recent evidence from the
 * local DB across the user's connected integrations. Per integration, decides
 * whether the cached evidence is fresh enough or whether to trigger a fresh
 * poll first; then ranks the surviving rows and shapes them to the wire
 * contract.
 *
 * Ranking heuristic (deliberately simple — easy to swap once we have signal):
 *   recencyScore = 1 / (1 + ageHours / 24)         (~ half-life of one day)
 *   kindBoost    = 0.5 if kind ∈ {mention, review_request, dm} else 0
 *   score        = recencyScore + kindBoost
 *   priority     = rank index + 1                  (1 = highest)
 *
 * Tie-break is explicit (score desc, occurredAtMs desc, id asc) so equal-score
 * rows have a deterministic order independent of SQLite's row-fetch order.
 *
 * Pollers are injected via the factory (`pollers`) rather than read out of the
 * MCP context, because the integration poll functions need auth tokens that
 * the MCP `ToolHandlerContext` deliberately does not carry. The host
 * (`apps/mcp-local` once it lands) builds closures that capture tokens at
 * startup; tests pass `vi.fn()` mocks.
 *
 * Row shaping is defensive: a single corrupt `evidence_log` row (empty title,
 * malformed citation URL, unparseable payload JSON) downgrades or is skipped,
 * never aborts the whole tool call.
 */

import { type EvidenceLogEntry, type Freshness, StartSessionArgs, StartSessionResult } from '@slopweaver/contracts';
import { evidenceLog, integrationState, type SlopweaverDatabase } from '@slopweaver/db';
import { ok } from '@slopweaver/errors';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { defineTool, type Tool } from '../registry.ts';
import { shapeEvidenceRow } from '../shape-evidence.ts';

/** Default: poll if the most recent successful poll completed more than 10 minutes ago. */
const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000;

const KIND_BOOST = new Set<string>(['mention', 'review_request', 'dm']);
const KIND_BOOST_VALUE = 0.5;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Per-integration refresh hook. The host wires one of these up per connected
 * integration with the auth token captured in the closure. Called when the
 * tool decides the cache is stale or `force_refresh` was set.
 */
export type StartSessionPoller = (args: { db: SlopweaverDatabase; now: number }) => Promise<void>;

export type CreateStartSessionToolArgs = {
  /** Map from integration slug (`'github'`, `'slack'`) to its refresh hook. Integrations without a registered poller are simply not refreshed. */
  pollers?: Record<string, StartSessionPoller>;
  /** Override the default 10-minute staleness threshold (e.g. for tests). */
  staleThresholdMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
};

type EvidenceRow = typeof evidenceLog.$inferSelect;
type StartSessionItem = z.infer<typeof StartSessionResult>['items'][number];
type ShapedEntry = { item: Omit<StartSessionItem, 'priority'>; evidence: EvidenceLogEntry };

/**
 * Build the `start_session` MCP tool — the composite "what should I work on
 * next?" endpoint. Pulls ranked evidence from `evidence_log` across requested
 * integrations and optionally refreshes any integration whose cache is older
 * than `staleThresholdMs` (or when the caller passes `force_refresh: true`).
 *
 * @param args.pollers - Per-integration refresh hooks (defaults to none — the
 *   tool returns whatever's in the cache without refreshing).
 * @param args.staleThresholdMs - How old cached evidence must be before a
 *   refresh fires. Defaults to {@link DEFAULT_STALE_THRESHOLD_MS}.
 * @param args.now - Clock injection for tests; defaults to `Date.now`.
 */
export function createStartSessionTool(args: CreateStartSessionToolArgs = {}): Tool {
  const pollers = args.pollers ?? {};
  const staleThresholdMs = args.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const now = args.now ?? Date.now;

  return defineTool({
    name: 'start_session',
    description:
      'Returns ranked evidence for "what should I work on next?" across the connected integrations. Optionally triggers a fresh poll per integration when cached evidence is stale or `force_refresh` is set.',
    inputSchema: StartSessionArgs,
    outputSchema: StartSessionResult,
    handler: async ({ input, ctx: { db } }) => {
      const nowMs = now();
      const cap = Math.min(input.max_items ?? 10, 25);

      const requested = resolveRequested(db, input.integrations, pollers);

      if (requested.length === 0) {
        return ok({
          items: [],
          evidence: [],
          freshness: [],
          generated_at: new Date(nowMs).toISOString(),
        });
      }

      for (const integration of requested) {
        if (shouldPoll(db, integration, nowMs, staleThresholdMs, input.force_refresh === true)) {
          const poller = pollers[integration];
          if (poller) {
            // Recovery catch (see .claude/rules/error-handling.md "Legitimate
            // recovery catches"): a single integration's poller throwing
            // (revoked token, rate limit, transient 5xx) must not abort the
            // whole tool call. The failing integration's `Freshness.stale`
            // remains true because `markPollCompleted` was never called —
            // that's the contract.
            try {
              await poller({ db, now: nowMs });
            } catch (error) {
              process.stderr.write(`slopweaver: ${integration} poller failed: ${describeError(error)}\n`);
            }
          }
        }
      }

      const rows: EvidenceRow[] = db
        .select()
        .from(evidenceLog)
        .where(inArray(evidenceLog.integration, requested))
        .orderBy(desc(evidenceLog.occurredAtMs))
        .all();

      const ranked = rows.map((row) => ({ row, score: scoreOf(row, nowMs) })).sort(compareRanked);

      const built: ShapedEntry[] = [];
      for (const entry of ranked) {
        if (built.length >= cap) break;
        const shaped = shapeRow(entry.row, nowMs);
        if (shaped) built.push(shaped);
      }

      const items: StartSessionItem[] = built.map((b, idx) => ({ ...b.item, priority: idx + 1 }));
      const evidence: EvidenceLogEntry[] = built.map((b) => b.evidence);
      const freshness: Freshness[] = requested.map((integration) =>
        readFreshness(db, integration, nowMs, staleThresholdMs),
      );

      return ok({
        items,
        evidence,
        freshness,
        generated_at: new Date(nowMs).toISOString(),
      });
    },
  });
}

/**
 * Pick the integrations to consider this call. When the caller supplies
 * `inputIntegrations` we honour that exactly (deduped). Otherwise default to
 * the union of registered pollers and existing `integration_state` rows so a
 * first-run `force_refresh` actually has something to poll. First-seen order
 * is preserved.
 */
function resolveRequested(
  db: SlopweaverDatabase,
  inputIntegrations: readonly string[] | undefined,
  pollers: Record<string, StartSessionPoller>,
): string[] {
  if (inputIntegrations !== undefined) {
    return dedupeOrdered(inputIntegrations);
  }
  const stateRows = db
    .select({ integration: integrationState.integration })
    .from(integrationState)
    .all()
    .map((r) => r.integration);
  return dedupeOrdered([...Object.keys(pollers), ...stateRows]);
}

function dedupeOrdered(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of values) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

function shouldPoll(
  db: SlopweaverDatabase,
  integration: string,
  nowMs: number,
  staleThresholdMs: number,
  forceRefresh: boolean,
): boolean {
  if (forceRefresh) return true;
  const stateRow = db
    .select({ lastPollCompletedAtMs: integrationState.lastPollCompletedAtMs })
    .from(integrationState)
    .where(eq(integrationState.integration, integration))
    .get();
  const last = stateRow?.lastPollCompletedAtMs;
  return last == null || nowMs - last > staleThresholdMs;
}

function readFreshness(
  db: SlopweaverDatabase,
  integration: string,
  nowMs: number,
  staleThresholdMs: number,
): Freshness {
  const stateRow = db
    .select({ lastPollCompletedAtMs: integrationState.lastPollCompletedAtMs })
    .from(integrationState)
    .where(eq(integrationState.integration, integration))
    .get();
  const last = stateRow?.lastPollCompletedAtMs ?? null;
  return {
    integration,
    last_polled_at: last != null ? new Date(last).toISOString() : null,
    stale: last == null || nowMs - last > staleThresholdMs,
  };
}

function scoreOf(row: EvidenceRow, nowMs: number): number {
  const ageMs = Math.max(0, nowMs - row.occurredAtMs);
  const ageHours = ageMs / MS_PER_HOUR;
  const recencyScore = 1 / (1 + ageHours / 24);
  const boost = KIND_BOOST.has(row.kind) ? KIND_BOOST_VALUE : 0;
  return recencyScore + boost;
}

function compareRanked(a: { row: EvidenceRow; score: number }, b: { row: EvidenceRow; score: number }): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.row.occurredAtMs !== a.row.occurredAtMs) return b.row.occurredAtMs - a.row.occurredAtMs;
  return a.row.id - b.row.id;
}

/**
 * Defensively convert a DB row to the wire shape. Returns `null` if the row
 * cannot produce a contract-valid item — either because both `title` and
 * `kind` are empty (so the ranking item has no title) or because the shared
 * `shapeEvidenceRow` helper rejected the row (empty `integration`/`kind`).
 * The title fallback stays here because it's specific to start_session's
 * ranking item; the EvidenceLogEntry shape itself comes from the shared
 * helper so the same defensive rules apply across every read tool.
 */
function shapeRow(row: EvidenceRow, nowMs: number): ShapedEntry | null {
  // Both `row.title` and `row.kind` can be empty strings; we want either an
  // empty-string `title` or an empty-string `kind` to collapse to `null`
  // (and skip the row). Explicit length checks avoid the `||` / `??` choice
  // — neither operator gets the empty-string semantics right on its own.
  const candidate = row.title && row.title.length > 0 ? row.title : row.kind;
  const title = candidate.length > 0 ? candidate : null;
  if (title === null) return null;

  const evidence = shapeEvidenceRow(row);
  if (evidence == null) return null;

  return {
    item: {
      ref: evidence.ref,
      title,
      why: `${row.integration} ${row.kind} from ${humanAge(nowMs - row.occurredAtMs)}`,
      evidence_ids: [String(row.id)],
    },
    evidence,
  };
}

/**
 * Stringify an unknown caught value for stderr logs. Native `Error` instances
 * expose `.message`; `Result`-pattern errors (BaseError-shaped plain objects)
 * also carry a string `message` — extract it explicitly so the recovery-catch
 * log line prints `…: <message>` instead of `[object Object]`. Mirrors the
 * `asMessage()` helper at the CLI boundary in `apps/mcp-local/src/cli.ts`.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

function humanAge(ageMs: number): string {
  const safe = Math.max(0, ageMs);
  const minutes = Math.floor(safe / MS_PER_MINUTE);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(safe / MS_PER_HOUR);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(safe / MS_PER_DAY);
  return `${days}d ago`;
}
