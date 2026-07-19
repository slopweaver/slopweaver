/**
 * The one embedding-IO edge for a query: build the document vector index (read-only) and embed the
 * query. Fail-soft — if the embedder is unavailable (no model, broken binding), it returns `degraded`
 * and emits a LOUD stderr warning, and the caller falls back to BM25-only. The loudness is deliberate: a
 * silent fallback once dead-featured semantic search for everyone.
 */
import type { CorpusRecord } from "../corpus/types.js";
import type { Embedder } from "./embeddings.js";
import { buildVectorIndex, type EmbedProgress, type VectorCacheStore, type VectorIndex } from "./vectorIndex.js";

export interface SemanticContext {
  readonly queryVector: Float32Array;
  readonly vectorIndex: VectorIndex;
}

export interface SemanticDeps {
  readonly embedder: Embedder;
  readonly store: VectorCacheStore;
}

export interface SemanticPreparation {
  readonly context?: SemanticContext;
  readonly degraded: boolean;
  readonly reason?: string;
}

export type WarnSink = (message: string) => void;

/**
 * Prepare the semantic context for a query, or degrade to BM25-only.
 *
 * @param records the corpus records to index
 * @param query the query string
 * @param deps the embedder + vector cache
 * @param enabled whether semantic search was requested
 * @param warn optional sink for the loud degradation warning
 * @returns the context, or `{ degraded: true, reason }`
 */
export async function prepareSemanticContext({
  records,
  query,
  deps,
  enabled,
  warn,
  onProgress,
}: {
  records: readonly CorpusRecord[];
  query: string;
  deps: SemanticDeps;
  enabled: boolean;
  warn?: WarnSink;
  onProgress?: (progress: EmbedProgress) => void;
}): Promise<SemanticPreparation> {
  if (!enabled) {
    return { degraded: false };
  }
  const degrade = ({ reason }: { reason: string }): SemanticPreparation => {
    warn?.(
      `[slopweaver] semantic search requested but the embedder is unavailable; falling back to BM25-only (${reason})`,
    );
    return { degraded: true, reason };
  };
  try {
    // Persist: slopweaver always indexes the FULL corpus here (not a candidate subset), so writing the
    // cache back is safe and gives incremental reuse — only new/changed records re-embed next query.
    const vectorIndex = await buildVectorIndex({
      embedder: deps.embedder,
      persist: true,
      records,
      store: deps.store,
      ...(onProgress !== undefined ? { onProgress } : {}),
    });
    const [queryVector] = await deps.embedder.embedQuery([query]);
    if (queryVector === undefined) {
      return degrade({ reason: "empty query vector" });
    }
    return { context: { queryVector, vectorIndex }, degraded: false };
  } catch (error: unknown) {
    return degrade({ reason: error instanceof Error ? error.message : "unknown error" });
  }
}
