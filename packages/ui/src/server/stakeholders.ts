/**
 * `/api/stakeholders` response builder. Aggregates interaction
 * volume per stakeholder by counting evidence_log rows whose payload
 * mentions each person. v1.1 first cut uses a simple identity map:
 * we don't have a persisted team_directory table yet, so the response
 * is derived purely from the evidence_log row counts grouped by
 * `payload_json -> 'author'`.
 *
 * Production writers (GitHub + Slack pollers in
 * `packages/integrations/{github,slack}/src`) normalise a top-level
 * `author` field onto `payload_json` on write, so this builder reads a
 * single, stable path. Rows without an `author` (legacy rows pre-dating
 * the normalisation, or future integrations that haven't been wired in)
 * are surfaced explicitly under `unattributed_count` rather than
 * silently dropped — so a consumer can tell apart "no stakeholders
 * found" from "many rows, none attributable yet".
 *
 * Returns the top-N stakeholders by row count. A ranked list, not a
 * graph layout — stakeholder co-occurrence edges are deferred.
 */

import { evidenceLog, type SlopweaverDatabase } from '@slopweaver/db';
import { sql } from 'drizzle-orm';

const DEFAULT_LIMIT = 25;

export type StakeholderEntry = {
  /** Author identifier as seen in payload_json — typically a platform handle. */
  identifier: string;
  /** Total interaction count across evidence_log. */
  interactions: number;
  /** Most-recent interaction (ISO datetime). */
  last_seen: string;
};

export type StakeholdersResponse = {
  entries: ReadonlyArray<StakeholderEntry>;
  /** Total distinct identifiers found (may exceed entries.length when the limit clamps). */
  total: number;
  /**
   * Count of evidence_log rows whose payload_json had no top-level `author`
   * field. Surfaced so consumers can tell "no data" apart from "rows exist
   * but aren't attributable yet" (e.g. older rows pre-dating the
   * payload-normalisation, or a future integration that hasn't been wired
   * to write the `author` field).
   */
  unattributed_count: number;
  generated_at: string;
};

export type BuildStakeholdersArgs = {
  db: SlopweaverDatabase;
  limit?: number;
  nowMs?: number;
};

export function buildStakeholdersResponse(args: BuildStakeholdersArgs): StakeholdersResponse {
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, 100);
  const nowMs = args.nowMs ?? Date.now();

  // Build an aggregate via SQL: extract `payload_json -> 'author'`,
  // count occurrences, take the max occurredAtMs. SQLite's json_extract
  // is the right knife for this — no need to deserialize every row in
  // JS.
  const rows = args.db
    .select({
      identifier: sql<string | null>`json_extract(${evidenceLog.payloadJson}, '$.author')`.as('identifier'),
      interactions: sql<number>`count(*)`.as('interactions'),
      lastSeenMs: sql<number>`max(${evidenceLog.occurredAtMs})`.as('lastSeenMs'),
    })
    .from(evidenceLog)
    .groupBy(sql`json_extract(${evidenceLog.payloadJson}, '$.author')`)
    .all();

  const filtered: StakeholderEntry[] = [];
  let unattributedCount = 0;
  for (const row of rows) {
    if (row.identifier === null || row.identifier.length === 0) {
      // Group row for "no author" — the aggregate count is the number of
      // unattributed evidence_log rows.
      unattributedCount += row.interactions;
      continue;
    }
    filtered.push({
      identifier: row.identifier,
      interactions: row.interactions,
      last_seen: new Date(row.lastSeenMs).toISOString(),
    });
  }
  filtered.sort((a, b) => b.interactions - a.interactions || a.identifier.localeCompare(b.identifier));

  return {
    entries: filtered.slice(0, limit),
    total: filtered.length,
    unattributed_count: unattributedCount,
    generated_at: new Date(nowMs).toISOString(),
  };
}
