/**
 * Small collection primitives that had been reimplemented across silver, distil, and retrieval — count
 * maps (`m.set(k, (m.get(k) ?? 0) + 1)`), sorted-unique arrays, and the "clamp the limit to ≥0 before
 * slicing" guard the retrieval rankers hand-rolled. Pure and tested once here.
 */
import { compareStrings } from "./compare.js";

/**
 * Distinct values, sorted ascending by code point. Pure — the input is not mutated.
 *
 * @param values the values (with possible duplicates)
 * @returns the distinct values in ascending order
 */
export function sortedUnique({ values }: { values: readonly string[] }): readonly string[] {
  return [...new Set(values)].toSorted((a, b) => compareStrings({ a, b }));
}

/**
 * Count occurrences of each key. Pure — replaces the scattered `map.set(k, (map.get(k) ?? 0) + 1)` loops.
 *
 * @param keys the keys to tally (order-independent)
 * @returns a map of key → count
 */
export function countBy({ keys }: { keys: readonly string[] }): Map<string, number> {
  const counts = new Map<string, number>();
  for (const key of keys) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/**
 * Increment one key's count in place (the single-step form of {@link countBy}). Mutates + returns `counts`
 * so it composes inside an accumulation loop. The map itself is the caller's local state, never shared.
 *
 * @param counts the count map to mutate
 * @param key the key to bump
 * @returns the same map, with `key`'s count incremented
 */
export function incrementCount({ counts, key }: { counts: Map<string, number>; key: string }): Map<string, number> {
  counts.set(key, (counts.get(key) ?? 0) + 1);
  return counts;
}

/**
 * The first `limit` items, with the limit clamped to `[0, length]` — the `slice(0, Math.max(0, limit))`
 * guard the hybrid ranker used so a negative limit yields `[]` rather than dropping the tail. Pure.
 *
 * @param items the items to take from
 * @param limit the requested count (negative ⇒ `[]`, larger-than-length ⇒ all)
 * @returns the clamped prefix
 */
export function takeClamped<T>({ items, limit }: { items: readonly T[]; limit: number }): readonly T[] {
  return items.slice(0, Math.max(0, limit));
}
