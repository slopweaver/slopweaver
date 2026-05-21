/**
 * `recall` MCP tool — semantic search across `evidence_log`. For each
 * row we embed `title + ' ' + body` (best-effort: empty fields skipped)
 * and rank by cosine similarity with the query embedding.
 *
 * v1.1 first cut uses the deterministic signed-hash-bag embedder
 * (zero deps, pure function, fast). The embedder interface is async
 * so a follow-up can swap in a local transformer model (bge-small via
 * @xenova/transformers) behind the same `Embedder` interface — the
 * tool body doesn't change.
 *
 * The embedder is contracted to return L2-normalized vectors;
 * `cosineSimilarity` is a plain dot product in `[-1, 1]`. We filter
 * non-positive scores out — negatives indicate the document is
 * actively anti-correlated under signed hashing, which is noise we
 * don't want to surface.
 *
 * No migration here: embeddings are computed per query against the
 * live evidence_log. That's fine up to ~10K rows; beyond that we'll
 * add a cached `embedding` column behind a feature flag.
 */

import { RecallArgs, RecallResult, type EvidenceLogEntry } from '@slopweaver/contracts';
import { evidenceLog } from '@slopweaver/db';
import { ok } from '@slopweaver/errors';
import { and, eq, type SQL } from 'drizzle-orm';
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
      'Semantic search over evidence_log rows. Embeds the query and every (title + body) pair, ranks by cosine similarity, returns the top-N matches with their scores. v1.1 first cut uses a deterministic signed-hash-bag embedder; a real local model will land in a follow-up behind the same async interface.',
    inputSchema: RecallArgs,
    outputSchema: RecallResult,
    handler: async ({ input, ctx: { db } }) => {
      const limit = input.limit ?? DEFAULT_LIMIT;
      const queryVec = await embedder.embed(input.query);

      // Compose `integration` + `kind` filters in SQL via `and(...)` so
      // the dataset gets filtered before it hits JS — important once the
      // evidence_log grows past in-memory-sort scale.
      const conditions: SQL[] = [];
      if (input.filters?.integration !== undefined) {
        conditions.push(eq(evidenceLog.integration, input.filters.integration));
      }
      if (input.filters?.kind !== undefined) {
        conditions.push(eq(evidenceLog.kind, input.filters.kind));
      }
      const whereExpr = conditions.length === 0 ? undefined : and(...conditions);
      const rows =
        whereExpr === undefined
          ? db.select().from(evidenceLog).all()
          : db.select().from(evidenceLog).where(whereExpr).all();

      const scored: { entry: EvidenceLogEntry; score: number }[] = [];
      for (const row of rows) {
        const text = [row.title ?? '', row.body ?? ''].filter((s) => s.length > 0).join(' ');
        if (text.length === 0) continue;
        const docVec = await embedder.embed(text);
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
