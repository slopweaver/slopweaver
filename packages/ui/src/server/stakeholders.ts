/**
 * `/api/stakeholders` response builder. Aggregates interaction
 * volume per stakeholder by counting evidence_log rows whose payload
 * mentions each person. v1.1 first cut uses a simple identity map:
 * we don't have a persisted team_directory table yet, so the response
 * is derived purely from the evidence_log row counts grouped by
 * `payload_json -> 'author'` (when present).
 *
 * Returns the top-N stakeholders by row count. The eventual
 * force-graph layout uses these counts as edge weights; v1.1 ships
 * just the ranked list — the layout follows in a v1.2 PR.
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
  for (const row of rows) {
    if (row.identifier === null || row.identifier.length === 0) continue;
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
    generated_at: new Date(nowMs).toISOString(),
  };
}
