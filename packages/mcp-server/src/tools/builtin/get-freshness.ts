/**
 * Builtin `get_freshness` tool. Returns one `Freshness` entry per row in
 * `integration_state` so MCP clients can ask "how recent is my cached evidence
 * per integration?" without re-running ranking or polling. Read-only — does not
 * trigger any polls.
 *
 * Staleness is computed by the same rule `start_session` uses: a row is stale
 * when its `last_poll_completed_at_ms` is null or older than `staleThresholdMs`
 * before `now`. The default threshold mirrors `start_session`'s default of 10
 * minutes; both are duplicated rather than shared because cross-tool
 * deduplication is premature until a third caller appears.
 */

import { type Freshness, GetFreshnessArgs, GetFreshnessResult } from '@slopweaver/contracts';
import { integrationState } from '@slopweaver/db';
import { ok } from '@slopweaver/errors';
import { asc } from 'drizzle-orm';
import { defineTool, type Tool } from '../registry.ts';

/** Default: a poll older than 10 minutes is considered stale. Matches start_session. */
const DEFAULT_STALE_THRESHOLD_MS = 10 * 60 * 1000;

export type CreateGetFreshnessToolArgs = {
  /** Override the default 10-minute staleness threshold (e.g. for tests). */
  staleThresholdMs?: number;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
};

export function createGetFreshnessTool(args: CreateGetFreshnessToolArgs = {}): Tool {
  const staleThresholdMs = args.staleThresholdMs ?? DEFAULT_STALE_THRESHOLD_MS;
  const now = args.now ?? Date.now;

  return defineTool({
    name: 'get_freshness',
    description:
      'Returns the last successful poll time and staleness for each connected integration. Read-only; does not trigger any polls.',
    inputSchema: GetFreshnessArgs,
    outputSchema: GetFreshnessResult,
    handler: async ({ ctx: { db } }) => {
      const nowMs = now();
      // Explicit ORDER BY so the wire response is deterministic across SQLite
      // versions / query plans. Sort by `integration` alphabetically — stable
      // across re-polls (which only touch `last_poll_*` timestamps) and
      // independent of insertion order. The test pins this contract.
      const rows = db
        .select({
          integration: integrationState.integration,
          lastPollCompletedAtMs: integrationState.lastPollCompletedAtMs,
        })
        .from(integrationState)
        .orderBy(asc(integrationState.integration))
        .all();

      const freshness: Freshness[] = rows.map((row) => {
        const last = row.lastPollCompletedAtMs;
        return {
          integration: row.integration,
          last_polled_at: last != null ? new Date(last).toISOString() : null,
          stale: last == null || nowMs - last > staleThresholdMs,
        };
      });

      return ok({
        freshness,
        generated_at: new Date(nowMs).toISOString(),
      });
    },
  });
}
