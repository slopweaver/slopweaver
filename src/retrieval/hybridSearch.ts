/**
 * The live hybrid ranker: min-max-normalised BM25 ⊕ cosine, weighted by recency decay. Both sides score a
 * shared candidate pool, each is normalised into [0,1], blended `alpha*semantic + (1-alpha)*lexical`, then
 * multiplied by the record's decay weight.
 *
 * **Fail-soft:** the query vector + vector index are optional — absent, the semantic side is empty and the
 * blend collapses to BM25-only (never crashes). The relevance floor (cut candidates where both sides are
 * weak — substring bleed) applies ONLY when the semantic side actually contributed, so a strong
 * lexical-only hit is never floored away.
 *
 * Pure cores ({@link normaliseScores}, {@link hybridCandidateIds}, {@link shouldKeepHybridCandidate},
 * {@link blendHybridScore}, {@link rankHybridCandidates}) carry the maths + ordering + floor decisions and
 * are unit-tested; {@link hybridSearch} is the thin shell that reads both raw score sides and composes them.
 */
import { takeClamped } from "../lib/collections.js";
import { compareScoreDescThenIdAsc } from "../lib/compare.js";
import { type DecayParams, recordDecayWeight } from "./recencyDecay.js";
import { type RetrievalIndex, searchScored } from "./retrievalIndex.js";
import { cosineTopN, type VectorIndex } from "./vectorIndex.js";

export const DEFAULT_ALPHA = 0.5;
export const CANDIDATE_POOL = 200;

/**
 * Min-max normalise scores into [0,1]; a single or all-equal set maps to 1 (so a lone candidate isn't
 * zeroed). Pure — the input map is not mutated.
 *
 * @param scores the raw scores by id
 * @returns the normalised scores by id
 */
export function normaliseScores({ scores }: { scores: ReadonlyMap<string, number> }): Map<string, number> {
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
 * The candidate id pool: the union of both sides, in lexical-then-semantic insertion order (the ranking
 * sort is total, so this only fixes a deterministic starting order). Pure.
 *
 * @param lexical the normalised lexical scores
 * @param semantic the normalised semantic scores
 * @returns the deduped candidate ids
 */
export function hybridCandidateIds({
  lexical,
  semantic,
}: {
  lexical: ReadonlyMap<string, number>;
  semantic: ReadonlyMap<string, number>;
}): readonly string[] {
  return [...new Set([...lexical.keys(), ...semantic.keys()])];
}

/**
 * Whether a candidate survives the relevance floor: always kept unless the semantic side contributed AND
 * both sides are below the floor (substring bleed). Pure.
 *
 * @param semanticContributed whether the semantic side produced any score
 * @param lexicalScore the candidate's normalised lexical score
 * @param semanticScore the candidate's normalised semantic score
 * @param relevanceFloor the floor both sides must clear when semantic contributed
 * @returns true to keep the candidate
 */
export function shouldKeepHybridCandidate({
  semanticContributed,
  lexicalScore,
  semanticScore,
  relevanceFloor,
}: {
  semanticContributed: boolean;
  lexicalScore: number;
  semanticScore: number;
  relevanceFloor: number;
}): boolean {
  return !(semanticContributed && Math.max(lexicalScore, semanticScore) < relevanceFloor);
}

/**
 * The blended, decay-weighted score for one candidate. Pure.
 *
 * @param lexicalScore the normalised lexical score
 * @param semanticScore the normalised semantic score
 * @param alpha the semantic weight in [0,1]
 * @param decayWeight the recency-decay multiplier (1 when no decay)
 * @returns the final score
 */
export function blendHybridScore({
  lexicalScore,
  semanticScore,
  alpha,
  decayWeight,
}: {
  lexicalScore: number;
  semanticScore: number;
  alpha: number;
  decayWeight: number;
}): number {
  return (alpha * semanticScore + (1 - alpha) * lexicalScore) * decayWeight;
}

/**
 * Rank scored candidates (score desc, id asc) and take the clamped top `limit`. Pure — a negative/zero
 * limit yields `[]` rather than dumping the pool.
 *
 * @param candidates the scored `[id, score]` tuples
 * @param limit the max results
 * @returns the ranked ids
 */
export function rankHybridCandidates({
  candidates,
  limit,
}: {
  candidates: readonly (readonly [string, number])[];
  limit: number;
}): readonly string[] {
  const ranked = candidates.toSorted((a, b) => compareScoreDescThenIdAsc({ a, b }));
  return takeClamped({ items: ranked, limit }).map(([id]) => id);
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

  const lexical = normaliseScores({ scores: lexicalRaw });
  const semantic = normaliseScores({ scores: semanticRaw });
  const semanticContributed = semanticRaw.size > 0;

  const scored = hybridCandidateIds({ lexical, semantic })
    .filter((id) =>
      shouldKeepHybridCandidate({
        lexicalScore: lexical.get(id) ?? 0,
        relevanceFloor,
        semanticContributed,
        semanticScore: semantic.get(id) ?? 0,
      }),
    )
    .map((id): readonly [string, number] => {
      const decayWeight = decay !== undefined ? recordDecayWeight({ tsMs: index.tsMsById.get(id), ...decay }) : 1;
      return [
        id,
        blendHybridScore({
          alpha,
          decayWeight,
          lexicalScore: lexical.get(id) ?? 0,
          semanticScore: semantic.get(id) ?? 0,
        }),
      ];
    });
  return rankHybridCandidates({ candidates: scored, limit });
}
