/**
 * The distil batch cache: `content-hash → digest`, persisted at `corpus/.cache/distil/batches.json`
 * (rebuildable, gitignored). This is the incrementality engine — a batch whose hash is already cached is
 * served without an LLM call, so a re-run only spends tokens on batches whose bronze changed. Stale
 * hashes simply go unreferenced; the cache is keyed by hash, never pruned.
 */
import { isRecord } from '../lib/parsers.js'
import { readJsonFile, writeJsonFile } from '../lib/jsonFile.js'
import { distilCachePath } from '../corpus/corpusPaths.js'
import type { BatchDigest, DigestPoint } from './distil.js'
import type { CorpusSource } from '../corpus/types.js'

/** Validate one cached value into a `BatchDigest`, or undefined if malformed. */
function parseCachedDigest({ value }: { value: unknown }): BatchDigest | undefined {
  if (!isRecord(value) || typeof value.source !== 'string' || typeof value.container !== 'string'
    || typeof value.summary !== 'string' || !Array.isArray(value.points)) {
    return undefined
  }
  const points: DigestPoint[] = []
  for (const raw of value.points) {
    if (isRecord(raw) && typeof raw.point === 'string' && Array.isArray(raw.citations)) {
      points.push({ point: raw.point, citations: raw.citations.filter((c): c is string => typeof c === 'string') })
    }
  }
  return { source: value.source as CorpusSource, container: value.container, summary: value.summary, points }
}

/**
 * Load the batch cache.
 *
 * @param home the world-model home (defaults to the resolved home)
 * @returns a map from batch hash to cached digest (empty when no cache file)
 */
export function loadDistilCache({ home }: { home?: string } = {}): Map<string, BatchDigest> {
  const raw = readJsonFile({ path: distilCachePath(home === undefined ? {} : { home }) })
  const cache = new Map<string, BatchDigest>()
  if (isRecord(raw)) {
    for (const [hash, value] of Object.entries(raw)) {
      const digest = parseCachedDigest({ value })
      if (digest !== undefined) {
        cache.set(hash, digest)
      }
    }
  }
  return cache
}

/**
 * Persist the batch cache.
 *
 * @param cache the hash → digest map
 * @param home the world-model home (defaults to the resolved home)
 */
export function saveDistilCache({ cache, home }: { cache: ReadonlyMap<string, BatchDigest>; home?: string }): void {
  writeJsonFile({ path: distilCachePath(home === undefined ? {} : { home }), value: Object.fromEntries(cache) })
}
