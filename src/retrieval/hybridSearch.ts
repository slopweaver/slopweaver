/**
 * The live hybrid ranker: min-max-normalised BM25 ⊕ cosine, weighted by recency decay. Pure. Both sides
 * score a shared candidate pool, each is normalised into [0,1], blended `alpha*semantic + (1-alpha)*lexical`,
 * then multiplied by the record's decay weight.
 *
 * **Fail-soft:** the query vector + vector index are optional — absent, the semantic side is empty and
 * the blend collapses to BM25-only (never crashes). The relevance floor (cut candidates where both sides
 * are weak — substring bleed) applies ONLY when the semantic side actually contributed, so a strong
 * lexical-only hit is never floored away.
 */
import { type DecayParams, recordDecayWeight } from "./recencyDecay.js";
import { type RetrievalIndex, searchScored } from "./retrievalIndex.js";
import { cosineTopN, type VectorIndex } from "./vectorIndex.js";

export const DEFAULT_ALPHA = 0.5;
export const CANDIDATE_POOL = 200;

/** Min-max normalise scores into [0,1]; a single or all-equal set maps to 1. */
function minMaxNormalise({ scores }: { scores: ReadonlyMap<string, number> }): Map<string, number> {
  const values = [...scores.values()];
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const out = new Map<string, number>();
  for (const [id, value] of scores) {
    out.set(id, span > 0 ? (value - min) / span : 1);
  }
  return out;
}

/**
 * Rank candidate ids for a query, blending BM25 + cosine + recency.
 *
 * @param index the BM25 index
 * @param query the query string
 * @param queryVector the query's embedding (omit ⇒ BM25-only fail-soft)
 * @param vectorIndex the document vector index (omit ⇒ BM25-only fail-soft)
 * @param limit max results
 * @param alpha semantic weight in [0,1] (default {@link DEFAULT_ALPHA})
 * @param decay optional recency-decay params
 * @param candidatePool per-side candidate pool size (default {@link CANDIDATE_POOL})
 * @param bm25 optional BM25 tuning
 * @param relevanceFloor cut candidates weak on BOTH sides (default 0; skipped when semantic is absent)
 * @returns the ranked source ids
 */
export function hybridSearch({
  index,
  query,
  queryVector,
  vectorIndex,
  limit,
  alpha = DEFAULT_ALPHA,
  decay,
  candidatePool = CANDIDATE_POOL,
  bm25,
  relevanceFloor = 0,
}: {
  index: RetrievalIndex;
  query: string;
  queryVector?: Float32Array;
  vectorIndex?: VectorIndex;
  limit: number;
  alpha?: number;
  decay?: DecayParams;
  candidatePool?: number;
  bm25?: { k1?: number; b?: number };
  relevanceFloor?: number;
}): readonly string[] {
  const lexicalRaw = new Map(
    searchScored({ index, limit: candidatePool, query, ...(bm25 !== undefined ? { bm25 } : {}) }),
  );
  const semanticRaw =
    queryVector !== undefined && vectorIndex !== undefined
      ? new Map(cosineTopN({ index: vectorIndex, limit: candidatePool, queryVector }))
      : new Map<string, number>();

  const lexical = minMaxNormalise({ scores: lexicalRaw });
  const semantic = minMaxNormalise({ scores: semanticRaw });
  const semanticContributed = semanticRaw.size > 0;

  const scored: (readonly [string, number])[] = [];
  for (const id of new Set([...lexical.keys(), ...semantic.keys()])) {
    const lex = lexical.get(id) ?? 0;
    const sem = semantic.get(id) ?? 0;
    if (semanticContributed && Math.max(lex, sem) < relevanceFloor) {
      continue;
    }
    const blend = alpha * sem + (1 - alpha) * lex;
    const weight = decay !== undefined ? recordDecayWeight({ tsMs: index.tsMsById.get(id), ...decay }) : 1;
    scored.push([id, blend * weight]);
  }
  scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return scored.slice(0, Math.max(0, limit)).map(([id]) => id);
}
