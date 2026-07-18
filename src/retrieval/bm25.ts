/**
 * Okapi BM25 scoring primitives. Pure. The IDF is floored non-negative (the `1 +` inside the log) so a
 * very common term contributes ~nothing rather than a negative score that would penalise a document for
 * containing it.
 */

export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

export interface Bm25Stats {
  readonly docCount: number;
  readonly avgDocLength: number;
}

/**
 * Inverse document frequency for a term.
 *
 * @param df documents containing the term
 * @param docCount total documents
 * @returns the (non-negative) IDF
 */
export function bm25Idf({ df, docCount }: { df: number; docCount: number }): number {
  const clamped = Math.min(Math.max(df, 0), docCount);
  return Math.log(1 + (docCount - clamped + 0.5) / (clamped + 0.5));
}

/**
 * BM25 score contribution of one term in one document.
 *
 * @param termFrequency the term's frequency in the document
 * @param docFrequency documents containing the term
 * @param docLength the document's token length
 * @param stats corpus stats (doc count + average length)
 * @param k1 term-frequency saturation (default {@link BM25_K1})
 * @param b length-normalisation (default {@link BM25_B})
 * @returns the term's score contribution (0 when the term is absent)
 */
export function bm25TermScore({
  termFrequency,
  docFrequency,
  docLength,
  stats,
  k1 = BM25_K1,
  b = BM25_B,
}: {
  termFrequency: number;
  docFrequency: number;
  docLength: number;
  stats: Bm25Stats;
  k1?: number;
  b?: number;
}): number {
  if (termFrequency <= 0) {
    return 0;
  }
  const idf = bm25Idf({ df: docFrequency, docCount: stats.docCount });
  const lengthFactor = stats.avgDocLength > 0 ? 1 - b + b * (docLength / stats.avgDocLength) : 1;
  return (idf * (termFrequency * (k1 + 1))) / (termFrequency + k1 * lengthFactor);
}
