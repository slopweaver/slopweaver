/**
 * The BM25 inverted index over the corpus. Pure. The haystack per record is `title + text + refs`, so
 * an exact cross-ref key (e.g. `#42`, `TEAM-9`) is searchable. `search` ranks by summed BM25 × recency
 * decay; a negative limit fails closed to `[]` (never dumps the whole corpus).
 */
import type { CorpusRecord } from '../corpus/types.js'
import { bm25TermScore, type Bm25Stats } from './bm25.js'
import { type DecayParams, recordDecayWeight, tsIsoToMs } from './recencyDecay.js'
import { tokenise } from './tokenise.js'

export interface RetrievalIndex {
  readonly terms: Map<string, Map<string, number>>
  readonly tsMsById: Map<string, number | undefined>
  readonly docLengthById: Map<string, number>
  readonly stats: Bm25Stats
}

/** The searchable haystack for a record. */
function haystack({ record }: { record: CorpusRecord }): string {
  return `${record.title ?? ''} ${record.text} ${record.refs.join(' ')}`
}

/**
 * Build the BM25 index over the records.
 *
 * @param records the corpus records
 * @returns the inverted index
 */
export function buildRetrievalIndex({ records }: { records: readonly CorpusRecord[] }): RetrievalIndex {
  const terms = new Map<string, Map<string, number>>()
  const tsMsById = new Map<string, number | undefined>()
  const docLengthById = new Map<string, number>()
  let totalLength = 0
  for (const record of records) {
    const tokens = tokenise({ text: haystack({ record }) })
    docLengthById.set(record.sourceId, tokens.length)
    tsMsById.set(record.sourceId, tsIsoToMs({ tsIso: record.tsIso }))
    totalLength += tokens.length
    for (const token of tokens) {
      const postings = terms.get(token) ?? new Map<string, number>()
      postings.set(record.sourceId, (postings.get(record.sourceId) ?? 0) + 1)
      terms.set(token, postings)
    }
  }
  const docCount = records.length
  return { terms, tsMsById, docLengthById, stats: { docCount, avgDocLength: docCount > 0 ? totalLength / docCount : 0 } }
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
export function searchScored(
  { index, query, limit, decay, bm25 }: {
    index: RetrievalIndex
    query: string
    limit?: number
    decay?: DecayParams
    bm25?: { k1?: number; b?: number }
  },
): readonly (readonly [string, number])[] {
  if (limit !== undefined && limit < 0) {
    return []
  }
  const scores = new Map<string, number>()
  for (const term of new Set(tokenise({ text: query }))) {
    const postings = index.terms.get(term)
    if (postings === undefined) {
      continue
    }
    for (const [id, tf] of postings) {
      const score = bm25TermScore({
        termFrequency: tf,
        docFrequency: postings.size,
        docLength: index.docLengthById.get(id) ?? 0,
        stats: index.stats,
        ...(bm25?.k1 !== undefined ? { k1: bm25.k1 } : {}),
        ...(bm25?.b !== undefined ? { b: bm25.b } : {}),
      })
      scores.set(id, (scores.get(id) ?? 0) + score)
    }
  }
  const ranked = [...scores.entries()].map(([id, score]): readonly [string, number] => {
    const weighted = decay !== undefined ? score * recordDecayWeight({ tsMs: index.tsMsById.get(id), ...decay }) : score
    return [id, weighted]
  })
  ranked.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return limit !== undefined ? ranked.slice(0, limit) : ranked
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
export function search(
  { index, query, limit, decay, bm25 }: {
    index: RetrievalIndex
    query: string
    limit?: number
    decay?: DecayParams
    bm25?: { k1?: number; b?: number }
  },
): readonly string[] {
  return searchScored({ index, query, ...(limit !== undefined ? { limit } : {}), ...(decay !== undefined ? { decay } : {}), ...(bm25 !== undefined ? { bm25 } : {}) })
    .map(([id]) => id)
}
