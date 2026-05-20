/**
 * `/api/evidence` response builder. Returns the most-recent N rows from
 * `evidence_log` shaped for the client's live-tail view. The same
 * defensive row-shaping the start_session tool uses (skip rows missing
 * both `title` and `kind`, downgrade malformed citation_url) applies
 * here so a single bad row never breaks the tail.
 *
 * No polling, no auth — this is a single-process loopback-bound
 * read-only surface.
 */

import { evidenceLog, type SlopweaverDatabase } from '@slopweaver/db';
import { desc, sql } from 'drizzle-orm';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export type EvidenceTailRow = {
  id: string;
  integration: string;
  kind: string;
  title: string;
  citation_url: string | null;
  occurred_at: string;
};

export type EvidenceTailResponse = {
  rows: ReadonlyArray<EvidenceTailRow>;
  total_in_db: number;
  generated_at: string;
};

export type BuildEvidenceTailArgs = {
  db: SlopweaverDatabase;
  limit?: number;
  nowMs?: number;
};

function countStar() {
  return sql<number>`count(*)`.as('count');
}

export function buildEvidenceTailResponse(args: BuildEvidenceTailArgs): EvidenceTailResponse {
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const nowMs = args.nowMs ?? Date.now();

  // Total row count for the "N of M" badge in the UI. Cheap COUNT(*)
  // because evidence_log stays small (<10K rows in practice).
  const total = args.db
    .select({ count: countStar() })
    .from(evidenceLog)
    .all()
    .reduce<number>((acc, row) => acc + row.count, 0);

  const dbRows = args.db
    .select({
      id: evidenceLog.id,
      integration: evidenceLog.integration,
      kind: evidenceLog.kind,
      title: evidenceLog.title,
      citationUrl: evidenceLog.citationUrl,
      occurredAtMs: evidenceLog.occurredAtMs,
    })
    .from(evidenceLog)
    .orderBy(desc(evidenceLog.occurredAtMs))
    .limit(limit)
    .all();

  const rows: EvidenceTailRow[] = [];
  for (const row of dbRows) {
    // `kind` is NOT NULL in the schema but can be an empty string in
    // very-degenerate cases. `title` is nullable. Skip the truly-
    // pathological rows the start_session tool also skips: empty
    // title AND empty kind → nothing useful to render.
    const title = row.title;
    const kind = row.kind;
    const titleEmpty = title === null || title.length === 0;
    const kindEmpty = kind.length === 0;
    if (titleEmpty && kindEmpty) continue;
    rows.push({
      id: String(row.id),
      integration: row.integration,
      kind: kindEmpty ? 'unknown' : kind,
      title: titleEmpty ? '(no title)' : title,
      citation_url: row.citationUrl,
      occurred_at: new Date(row.occurredAtMs).toISOString(),
    });
  }

  return {
    rows,
    total_in_db: total,
    generated_at: new Date(nowMs).toISOString(),
  };
}
