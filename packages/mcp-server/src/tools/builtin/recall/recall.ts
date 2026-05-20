/**
 * `recall` MCP tool — semantic search across `evidence_log`. For each
 * row we embed `title + ' ' + body` (best-effort: empty fields skipped)
 * and rank by cosine similarity with the query embedding.
 *
 * v1.1 first cut uses the deterministic hash-bag embedder (zero deps,
 * pure functions, fast). A follow-up will swap in a local transformer
 * model (bge-small via @xenova/transformers) behind the same
 * `Embedder` interface — the tool body doesn't change.
 *
 * No migration here: embeddings are computed per query against the
 * live evidence_log. That's fine up to ~10K rows; beyond that we'll
 * add a cached `embedding` column behind a feature flag.
 */

import { RecallArgs, RecallResult, type EvidenceLogEntry } from '@slopweaver/contracts';
import { evidenceLog } from '@slopweaver/db';
import { ok } from '@slopweaver/errors';
import { eq } from 'drizzle-orm';
import { defineTool, type Tool } from '../../registry.ts';
import { shapeEvidenceRow } from '../../shape-evidence.ts';
import { cosineSimilarity, createHashBagEmbedder, type Embedder } from './embedder.ts';

const DEFAULT_LIMIT = 10;

export type CreateRecallToolArgs = {
  /** Override the embedder (tests + a future swap to a real model). */
  embedder?: Embedder;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
};

export function createRecallTool(args: CreateRecallToolArgs = {}): Tool {
  const embedder = args.embedder ?? createHashBagEmbedder();
  const now = args.now ?? Date.now;

  return defineTool({
    name: 'recall',
    description:
      'Semantic search over evidence_log rows. Embeds the query and every (title + body) pair, ranks by cosine similarity, returns the top-N matches with their scores. v1.1 first cut uses a deterministic hash-bag embedder; a real local model will land in a follow-up behind the same interface.',
    inputSchema: RecallArgs,
    outputSchema: RecallResult,
    handler: async ({ input, ctx: { db } }) => {
      const limit = input.limit ?? DEFAULT_LIMIT;
      const queryVec = embedder.embed(input.query);

      let query = db.select().from(evidenceLog).$dynamic();
      if (input.filters?.integration !== undefined) {
        query = query.where(eq(evidenceLog.integration, input.filters.integration));
      }
      // Drizzle's $dynamic builder only supports one .where() chain, so we
      // can't easily AND both filters. Materialize and filter `kind` in JS
      // for v1.1 first cut — the dataset stays small (<10K rows) so the
      // overhead is negligible. A follow-up can move both filters into SQL
      // when the row count grows.
      const rows = query.all();
      const filteredKind = input.filters?.kind;
      const candidateRows = filteredKind === undefined ? rows : rows.filter((r) => r.kind === filteredKind);

      const scored: { entry: EvidenceLogEntry; score: number }[] = [];
      for (const row of candidateRows) {
        const text = [row.title ?? '', row.body ?? ''].filter((s) => s.length > 0).join(' ');
        if (text.length === 0) continue;
        const docVec = embedder.embed(text);
        const score = cosineSimilarity(queryVec, docVec);
        if (score <= 0) continue;
        const shaped = shapeEvidenceRow(row);
        if (shaped === null) continue;
        scored.push({ entry: shaped, score });
      }
      scored.sort((a, b) => b.score - a.score);
      const hits = scored.slice(0, limit).map(({ entry, score }) => ({ evidence: entry, score }));

      return ok({
        hits,
        generated_at: new Date(now()).toISOString(),
        embedder: embedder.name,
      });
    },
  });
}
