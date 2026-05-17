/**
 * Builtin `search_work_context` tool. Full-text search across the local
 * `evidence_log.title + body` via the `evidence_log_fts` virtual table
 * (created by migration `0002_evidence_log_fts5.sql`). Read-only — does not
 * trigger any polls.
 *
 * Query sanitization: FTS5 has its own query syntax (`AND`, `OR`, `NOT`,
 * `NEAR`, `"phrase"`, `prefix*`, parentheses, column qualifiers). Passing a
 * raw user query straight through can either return surprising results or
 * throw a SQLite syntax error. We treat every whitespace-separated token as a
 * literal phrase by wrapping it in double quotes (with internal `"` doubled
 * per FTS5's escape rule); FTS5 then implicit-ANDs the tokens. This trades
 * FTS5's advanced operators for predictable, never-throws behaviour.
 *
 * Ordering: FTS5's built-in `rank` (BM25) — better matches first. Drizzle's
 * DSL doesn't model FTS5 MATCH or rank, so the query is issued via the
 * `sql` template against a typed raw row.
 */

import {
  type EvidenceLogEntry,
  SearchWorkContextArgs,
  SearchWorkContextResult,
} from '@slopweaver/contracts';
import { type evidenceLog } from '@slopweaver/db';
import { ok } from '@slopweaver/errors';
import { sql } from 'drizzle-orm';
import { defineTool, type Tool } from '../registry.ts';
import { shapeEvidenceRow } from '../shape-evidence.ts';

const MAX_RESULTS = 50;

type EvidenceRow = typeof evidenceLog.$inferSelect;

/** Shape returned by `SELECT e.* FROM evidence_log e ...` — snake_case from SQLite. */
type RawEvidenceRow = {
  id: number;
  integration: string;
  external_id: string;
  kind: string;
  citation_url: string | null;
  title: string | null;
  body: string | null;
  payload_json: string;
  occurred_at_ms: number;
  first_seen_at_ms: number;
  last_seen_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
};

export type CreateSearchWorkContextToolArgs = {
  /** Clock injection for tests. Defaults to `Date.now`. Affects only `generated_at`. */
  now?: () => number;
};

export function createSearchWorkContextTool(args: CreateSearchWorkContextToolArgs = {}): Tool {
  const now = args.now ?? Date.now;

  return defineTool({
    name: 'search_work_context',
    description:
      'Full-text search across cached evidence titles and bodies, ordered by relevance (BM25). Optional `filters.integration` / `filters.kind` narrow the result set. Read-only.',
    inputSchema: SearchWorkContextArgs,
    outputSchema: SearchWorkContextResult,
    handler: async ({ input, ctx: { db } }) => {
      const nowMs = now();
      const ftsQuery = sanitizeQuery(input.query);

      // If the query collapses to nothing after sanitization (e.g. all
      // whitespace once trimmed), short-circuit rather than asking FTS5 to
      // match an empty pattern.
      if (ftsQuery.length === 0) {
        return ok({
          evidence: [],
          generated_at: new Date(nowMs).toISOString(),
        });
      }

      const integration = input.filters?.integration;
      const kind = input.filters?.kind;

      let stmt = sql`
        SELECT e.* FROM evidence_log e
        INNER JOIN evidence_log_fts fts ON e.id = fts.rowid
        WHERE evidence_log_fts MATCH ${ftsQuery}
      `;
      if (integration) stmt = sql`${stmt} AND e.integration = ${integration}`;
      if (kind) stmt = sql`${stmt} AND e.kind = ${kind}`;
      stmt = sql`${stmt} ORDER BY rank LIMIT ${MAX_RESULTS}`;

      const rawRows = db.all<RawEvidenceRow>(stmt);
      const rows: EvidenceRow[] = rawRows.map(rawRowToEvidenceRow);
      const evidence: EvidenceLogEntry[] = rows
        .map(shapeEvidenceRow)
        .filter((entry): entry is EvidenceLogEntry => entry !== null);

      return ok({
        evidence,
        generated_at: new Date(nowMs).toISOString(),
      });
    },
  });
}

/**
 * Wrap each whitespace-separated token of `query` in double quotes (escaping
 * internal `"` to `""` per FTS5 spec) and join with spaces. FTS5 implicit-ANDs
 * the resulting phrases. Treats every operator character (`*`, `(`, `)`, `:`,
 * `AND`, `OR`, `NOT`) as part of the literal phrase — predictable, never
 * raises a syntax error.
 */
function sanitizeQuery(query: string): string {
  return query
    .split(/\s+/)
    .filter((tok) => tok.length > 0)
    .map((tok) => `"${tok.replace(/"/g, '""')}"`)
    .join(' ');
}

function rawRowToEvidenceRow(raw: RawEvidenceRow): EvidenceRow {
  return {
    id: raw.id,
    integration: raw.integration,
    externalId: raw.external_id,
    kind: raw.kind,
    citationUrl: raw.citation_url,
    title: raw.title,
    body: raw.body,
    payloadJson: raw.payload_json,
    occurredAtMs: raw.occurred_at_ms,
    firstSeenAtMs: raw.first_seen_at_ms,
    lastSeenAtMs: raw.last_seen_at_ms,
    createdAtMs: raw.created_at_ms,
    updatedAtMs: raw.updated_at_ms,
  };
}
