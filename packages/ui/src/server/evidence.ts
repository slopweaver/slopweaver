/**
 * `/api/evidence` response builder. Returns the most-recent N rows from
 * `evidence_log` shaped for the client's live-tail view. The same
 * defensive row-shaping the start_session tool uses (skip rows whose
 * title AND kind are both empty, downgrade malformed citation_url to
 * null) applies here so a single bad row never breaks the tail.
 *
 * The "renderable" predicate (title OR kind non-empty) is pushed into
 * SQL — both the `total_in_db` badge and the row tail count the same
 * population, so the badge can't disagree with the rendered list.
 *
 * No polling, no auth — this is a single-process loopback-bound
 * read-only surface.
 */

import { evidenceLog, type SlopweaverDatabase } from '@slopweaver/db';
import { and, desc, ne, or, sql } from 'drizzle-orm';
import { safeCitationUrl } from './shape-evidence.ts';

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

// Renderable predicate: at least one of (title, kind) is non-empty.
// `title` is nullable; `kind` is NOT NULL but can be ''. Using `or` so
// a row keeps if either column has signal.
const renderablePredicate = or(
  and(sql`${evidenceLog.title} IS NOT NULL`, ne(evidenceLog.title, '')),
  ne(evidenceLog.kind, ''),
);

export function buildEvidenceTailResponse(args: BuildEvidenceTailArgs): EvidenceTailResponse {
  const limit = Math.min(args.limit ?? DEFAULT_LIMIT, MAX_LIMIT);
  const nowMs = args.nowMs ?? Date.now();

  // Total count of *renderable* rows for the "N of M" badge in the UI.
  // Mirrors the WHERE clause used for the row tail so the badge can't
  // claim a higher number than the tail can ever display. Cheap
  // COUNT(*) because evidence_log stays small (<10K rows in practice).
  const total = args.db
    .select({ count: countStar() })
    .from(evidenceLog)
    .where(renderablePredicate)
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
    .where(renderablePredicate)
    .orderBy(desc(evidenceLog.occurredAtMs))
    .limit(limit)
    .all();

  const rows: EvidenceTailRow[] = dbRows.map((row) => {
    const title = row.title;
    const kind = row.kind;
    const titleEmpty = title === null || title.length === 0;
    const kindEmpty = kind.length === 0;
    return {
      id: String(row.id),
      integration: row.integration,
      kind: kindEmpty ? 'unknown' : kind,
      title: titleEmpty ? '(no title)' : title,
      citation_url: safeCitationUrl(row.citationUrl),
      occurred_at: new Date(row.occurredAtMs).toISOString(),
    };
  });

  return {
    rows,
    total_in_db: total,
    generated_at: new Date(nowMs).toISOString(),
  };
}
