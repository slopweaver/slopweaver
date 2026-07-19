/**
 * The BM25 inverted index over the corpus. Pure. The haystack per record is `title + text + refs`, so
 * an exact cross-ref key (e.g. `#42`, `TEAM-9`) is searchable. `search` ranks by summed BM25 × recency
 * decay; a negative limit fails closed to `[]` (never dumps the whole corpus).
 *
 * The scoring path is decomposed into pure cores — {@link uniqueQueryTerms}, {@link scoreTermPostings},
 * {@link accumulateBm25Scores}, {@link applyDecayToScores} — each unit-tested; {@link searchScored} just
 * composes them and applies the limit.
 */

import type { CorpusRecord } from "../corpus/types.js";
import { compareScoreDescThenIdAsc } from "../lib/compare.js";
import { type Bm25Stats, bm25TermScore } from "./bm25.js";
import { type DecayParams, recordDecayWeight, tsIsoToMs } from "./recencyDecay.js";
import { tokenise } from "./tokenise.js";

export interface RetrievalIndex {
  readonly terms: Map<string, Map<string, number>>;
  readonly tsMsById: Map<string, number | undefined>;
  readonly docLengthById: Map<string, number>;
  readonly stats: Bm25Stats;
}

/** The searchable haystack for a record. A title-less record (many comments have none) contributes nothing. */
function haystack({ record }: { record: CorpusRecord }): string {
  return [record.title, record.text, record.refs.join(" ")]
    .filter((part) => part !== undefined && part.length > 0)
    .join(" ");
}

/**
 * Build the BM25 index over the records.
 *
 * @param records the corpus records
 * @returns the inverted index
 */
export function buildRetrievalIndex({ records }: { records: readonly CorpusRecord[] }): RetrievalIndex {
  const terms = new Map<string, Map<string, number>>();
  const tsMsById = new Map<string, number | undefined>();
  const docLengthById = new Map<string, number>();
  let totalLength = 0;
  for (const record of records) {
    const tokens = tokenise({ text: haystack({ record }) });
    docLengthById.set(record.sourceId, tokens.length);
    tsMsById.set(record.sourceId, tsIsoToMs({ tsIso: record.tsIso }));
    totalLength += tokens.length;
    for (const token of tokens) {
      const postings = terms.get(token) ?? new Map<string, number>();
      postings.set(record.sourceId, (postings.get(record.sourceId) ?? 0) + 1);
      terms.set(token, postings);
    }
  }
  const docCount = records.length;
  return {
    docLengthById,
    stats: { avgDocLength: docCount > 0 ? totalLength / docCount : 0, docCount },
    terms,
    tsMsById,
  };
}

/** The distinct query terms (repeated terms count once). Pure. */
export function uniqueQueryTerms({ query }: { query: string }): readonly string[] {
  return [...new Set(tokenise({ text: query }))];
}

/**
 * The BM25 score each posting of one term contributes. Pure — an absent term (no postings) contributes
 * nothing (empty array).
 *
 * @param postings the term's `id → termFrequency` postings (undefined ⇒ term absent)
 * @param index the BM25 index
 * @param bm25 optional BM25 tuning
 * @returns `[id, score]` contributions
 */
export function scoreTermPostings({
  postings,
  index,
  bm25,
}: {
  postings: ReadonlyMap<string, number> | undefined;
  index: RetrievalIndex;
  bm25?: { k1?: number; b?: number };
}): readonly (readonly [string, number])[] {
  if (postings === undefined) {
    return [];
  }
  return [...postings].map(([id, tf]): readonly [string, number] => [
    id,
    bm25TermScore({
      docFrequency: postings.size,
      docLength: index.docLengthById.get(id) ?? 0,
      stats: index.stats,
      termFrequency: tf,
      ...(bm25?.k1 !== undefined ? { k1: bm25.k1 } : {}),
      ...(bm25?.b !== undefined ? { b: bm25.b } : {}),
    }),
  ]);
}

/**
 * Sum BM25 contributions across every query term. Pure — a term absent from the index is skipped.
 *
 * @param index the BM25 index
 * @param terms the distinct query terms
 * @param bm25 optional BM25 tuning
 * @returns summed score by id
 */
export function accumulateBm25Scores({
  index,
  terms,
  bm25,
}: {
  index: RetrievalIndex;
  terms: readonly string[];
  bm25?: { k1?: number; b?: number };
}): Map<string, number> {
  const scores = new Map<string, number>();
  for (const term of terms) {
    const contributions = scoreTermPostings({
      index,
      postings: index.terms.get(term),
      ...(bm25 !== undefined ? { bm25 } : {}),
    });
    for (const [id, score] of contributions) {
      scores.set(id, (scores.get(id) ?? 0) + score);
    }
  }
  return scores;
}

/**
 * Weight each score by recency decay (identity when no decay). Pure.
 *
 * @param index the BM25 index (for per-id timestamps)
 * @param scores the summed BM25 scores
 * @param decay optional recency-decay params
 * @returns `[id, weightedScore]` tuples
 */
export function applyDecayToScores({
  index,
  scores,
  decay,
}: {
  index: RetrievalIndex;
  scores: ReadonlyMap<string, number>;
  decay?: DecayParams;
}): readonly (readonly [string, number])[] {
  return [...scores.entries()].map(([id, score]): readonly [string, number] => [
    id,
    decay !== undefined ? score * recordDecayWeight({ tsMs: index.tsMsById.get(id), ...decay }) : score,
  ]);
}

/**
 * Score every candidate for a query: summed BM25 × recency decay. Exposes magnitudes for hybrid fusion.
 *
 * @param index the BM25 index
 * @param query the query string
 * @param limit max results (negative ⇒ `[]`)
 * @param decay optional recency-decay params
 * @param bm25 optional BM25 tuning
 * @returns `[sourceId, score]` pairs, score desc, ties by id asc
 */
export function searchScored({
  index,
  query,
  limit,
  decay,
  bm25,
}: {
  index: RetrievalIndex;
  query: string;
  limit?: number;
  decay?: DecayParams;
  bm25?: { k1?: number; b?: number };
}): readonly (readonly [string, number])[] {
  if (limit !== undefined && limit < 0) {
    return [];
  }
  const scores = accumulateBm25Scores({
    index,
    terms: uniqueQueryTerms({ query }),
    ...(bm25 !== undefined ? { bm25 } : {}),
  });
  const ranked = applyDecayToScores({ index, scores, ...(decay !== undefined ? { decay } : {}) }).toSorted((a, b) =>
    compareScoreDescThenIdAsc({ a, b }),
  );
  return limit !== undefined ? ranked.slice(0, limit) : ranked;
}

/**
 * Rank candidate ids for a query (BM25 × recency decay).
 *
 * @param index the BM25 index
 * @param query the query string
 * @param limit max results (negative ⇒ `[]`)
 * @param decay optional recency-decay params
 * @param bm25 optional BM25 tuning
 * @returns the ranked source ids
 */
export function search({
  index,
  query,
  limit,
  decay,
  bm25,
}: {
  index: RetrievalIndex;
  query: string;
  limit?: number;
  decay?: DecayParams;
  bm25?: { k1?: number; b?: number };
}): readonly string[] {
  return searchScored({
    index,
    query,
    ...(limit !== undefined ? { limit } : {}),
    ...(decay !== undefined ? { decay } : {}),
    ...(bm25 !== undefined ? { bm25 } : {}),
  }).map(([id]) => id);
}
