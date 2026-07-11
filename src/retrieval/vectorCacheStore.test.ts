import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diskVectorCacheStore } from './vectorCacheStore.js'
import { EMBEDDING_DIM } from './embeddings.js'
import type { CachedVector } from './vectorIndex.js'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'slop-vec-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const good: CachedVector = { sourceId: '#1', contentHash: 'h', vector: new Float32Array(EMBEDDING_DIM).fill(0.1) }
const wrongDim: CachedVector = { sourceId: '#2', contentHash: 'h', vector: Float32Array.from([1, 0]) }

describe('diskVectorCacheStore', () => {
  it('round-trips a full-dimension vector', async () => {
    const store = diskVectorCacheStore({ cacheDir: dir })
    await store.save([good])
    const loaded = await store.load()
    expect(loaded).toHaveLength(1)
    expect(loaded[0].vector).toHaveLength(EMBEDDING_DIM)
  })

  it('drops wrong-dimension rows on load', async () => {
    const store = diskVectorCacheStore({ cacheDir: dir })
    await store.save([good, wrongDim])
    expect((await store.load()).map((v) => v.sourceId)).toEqual(['#1'])
  })
})
