/**
 * Shared ordering primitives — the comparators that had been reimplemented across distil, silver, and
 * retrieval (`a < b ? -1 : a > b ? 1 : 0` and `b[1] - a[1] || idAsc` in three retrieval rankers). Pure,
 * locale-independent, and deterministic so every ranked output is stable and unit-tested once here rather
 * than N times at the call-sites. Object-param comparators (the repo convention, matching distil/core's
 * `compareStrings`), wrapped inline at each `.sort`/`.toSorted`.
 */

/**
 * Ascending string comparator (locale-independent code-point order — NOT `localeCompare`, so ordering is
 * identical on every machine). Pure.
 *
 * @param a the first string
 * @param b the second string
 * @returns -1 when `a` sorts before `b`, 1 when after, 0 when equal
 */
export function compareStrings({ a, b }: { a: string; b: string }): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Descending numeric comparator (larger first). Pure.
 *
 * @param a the first number
 * @param b the second number
 * @returns a negative/positive/zero delta ordering `a` after/before/equal-to `b`
 */
export function compareNumbersDesc({ a, b }: { a: number; b: number }): number {
  return b - a;
}

/**
 * The retrieval ranking order: score descending, then id ascending as the deterministic tie-break — the
 * exact `b[1] - a[1] || (a[0] < b[0] ? -1 : …)` that `hybridSearch`, `retrievalIndex`, and `vectorIndex`
 * each hand-rolled. Operates on `[id, score]` tuples. Pure.
 *
 * @param a the first `[id, score]` tuple
 * @param b the second `[id, score]` tuple
 * @returns the comparator delta (score desc, id asc)
 */
export function compareScoreDescThenIdAsc({
  a,
  b,
}: {
  a: readonly [string, number];
  b: readonly [string, number];
}): number {
  return b[1] - a[1] || compareStrings({ a: a[0], b: b[0] });
}
