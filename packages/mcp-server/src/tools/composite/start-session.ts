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

import {
  EvidenceLogEntry,
  type Freshness,
  type Reference,
  StartSessionArgs,
  StartSessionResult,
} from '@slopweaver/contracts';
import { evidenceLog, integrationState, type SlopweaverDatabase } from '@slopweaver/db';
import { desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { defineTool, type Tool } from '../registry.ts';

/** Default: poll if the most recent successful poll completed more than 10 minutes ago. */
const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000;

const KIND_BOOST = new Set<string>(['mention', 'review_request', 'dm']);
const KIND_BOOST_VALUE = 0.5;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

const UrlSchema = z.url();

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
        return {
          items: [],
          evidence: [],
          freshness: [],
          generated_at: new Date(nowMs).toISOString(),
        };
      }

      for (const integration of requested) {
        if (shouldPoll(db, integration, nowMs, staleThresholdMs, input.force_refresh === true)) {
          const poller = pollers[integration];
          if (poller) {
            await poller({ db, now: nowMs });
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

      return {
        items,
        evidence,
        freshness,
        generated_at: new Date(nowMs).toISOString(),
      };
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

function compareRanked(
  a: { row: EvidenceRow; score: number },
  b: { row: EvidenceRow; score: number },
): number {
  if (b.score !== a.score) return b.score - a.score;
  if (b.row.occurredAtMs !== a.row.occurredAtMs) return b.row.occurredAtMs - a.row.occurredAtMs;
  return a.row.id - b.row.id;
}

/**
 * Defensively convert a DB row to the wire shape. Returns `null` if the row
 * cannot produce a contract-valid item (e.g. both `title` and `kind` are
 * empty). Recoverable issues are downgraded inline:
 *   - malformed `citation_url` → ref becomes canonical, `citation_url` null
 *   - unparseable `payload_json` → `payload_json` becomes null
 */
function shapeRow(row: EvidenceRow, nowMs: number): ShapedEntry | null {
  const title = (row.title && row.title.length > 0 ? row.title : row.kind) || null;
  if (title == null) return null;

  const ref = buildRef(row);
  const citationUrl = ref.kind === 'url' ? ref.url : null;
  const payload = tryParseJson(row.payloadJson);

  const evidence: EvidenceLogEntry = {
    id: String(row.id),
    integration: row.integration,
    kind: row.kind,
    ref,
    occurred_at: new Date(row.occurredAtMs).toISOString(),
    payload_json: payload,
    citation_url: citationUrl,
  };

  return {
    item: {
      ref,
      title,
      why: `${row.integration} ${row.kind} from ${humanAge(nowMs - row.occurredAtMs)}`,
      evidence_ids: [String(row.id)],
    },
    evidence,
  };
}

function buildRef(row: EvidenceRow): Reference {
  if (row.citationUrl != null && row.citationUrl.length > 0) {
    const parsed = UrlSchema.safeParse(row.citationUrl);
    if (parsed.success) {
      return { kind: 'url', url: parsed.data };
    }
  }
  return { kind: 'canonical', integration: row.integration, id: row.externalId };
}

function tryParseJson(json: string): z.infer<typeof EvidenceLogEntry>['payload_json'] {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
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
