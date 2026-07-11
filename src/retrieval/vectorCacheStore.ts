/**
 * On-disk vector cache — NDJSON (`vectors.jsonl`), one `{sourceId, contentHash, vector}` per line. NDJSON
 * deliberately, NOT one big JSON array: at scale a single `JSON.stringify`/`readFileSync` of the whole
 * corpus's vectors crosses V8's ~512MB max-string limit and throws, which would silently and permanently
 * degrade semantic search to BM25. Wrong-dimension rows are dropped on load (re-embedded), never used.
 */
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from '../lib/parsers.js'
import { EMBEDDING_DIM } from './embeddings.js'
import type { CachedVector, VectorCacheStore } from './vectorIndex.js'

export const VECTOR_CACHE_FILE = 'vectors.jsonl'
const SAVE_BATCH_ROWS = 5000

/** Parse one NDJSON line into a `CachedVector`, or undefined (blank/corrupt/wrong-dim). */
function parseLine({ line }: { line: string }): CachedVector | undefined {
  if (line.trim().length === 0) {
    return undefined
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (!isRecord(parsed) || typeof parsed.sourceId !== 'string' || typeof parsed.contentHash !== 'string' || !Array.isArray(parsed.vector)) {
    return undefined
  }
  if (parsed.vector.length !== EMBEDDING_DIM || !parsed.vector.every((n): n is number => typeof n === 'number')) {
    return undefined
  }
  return { sourceId: parsed.sourceId, contentHash: parsed.contentHash, vector: Float32Array.from(parsed.vector) }
}

/**
 * A disk-backed vector cache at `<cacheDir>/vectors.jsonl`.
 *
 * @param cacheDir the `.cache` directory
 * @returns the vector cache store
 */
export function diskVectorCacheStore({ cacheDir }: { cacheDir: string }): VectorCacheStore {
  const path = join(cacheDir, VECTOR_CACHE_FILE)
  return {
    load: async () => {
      let raw: string
      try {
        raw = readFileSync(path, 'utf8')
      } catch {
        return []
      }
      const vectors: CachedVector[] = []
      for (const line of raw.split('\n')) {
        const parsed = parseLine({ line })
        if (parsed !== undefined) {
          vectors.push(parsed)
        }
      }
      return vectors
    },
    save: async (vectors) => {
      mkdirSync(cacheDir, { recursive: true })
      writeFileSync(path, '', 'utf8')
      for (let i = 0; i < vectors.length; i += SAVE_BATCH_ROWS) {
        const rows = vectors.slice(i, i + SAVE_BATCH_ROWS)
          .map((v) => JSON.stringify({ sourceId: v.sourceId, contentHash: v.contentHash, vector: Array.from(v.vector) }))
        appendFileSync(path, rows.length > 0 ? `${rows.join('\n')}\n` : '', 'utf8')
      }
    },
  }
}
