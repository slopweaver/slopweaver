import { describe, expect, it } from 'vitest'
import { buildVectorIndex, cosine, cosineTopN, inMemoryVectorCacheStore, type VectorIndex } from './vectorIndex.js'
import type { Embedder } from './embeddings.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-01-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 't', refs: [], ...over,
})

describe('cosine', () => {
  it('is 1 for identical unit vectors, 0 for orthogonal, 0 on length mismatch', () => {
    expect(cosine({ a: Float32Array.from([1, 0]), b: Float32Array.from([1, 0]) })).toBe(1)
    expect(cosine({ a: Float32Array.from([1, 0]), b: Float32Array.from([0, 1]) })).toBe(0)
    expect(cosine({ a: Float32Array.from([1, 0]), b: Float32Array.from([1, 0, 0]) })).toBe(0)
  })
})

describe('cosineTopN', () => {
  it('ranks by similarity to the query vector', () => {
    const index: VectorIndex = { ids: ['#1', '#2'], vectors: [Float32Array.from([1, 0]), Float32Array.from([0, 1])] }
    expect(cosineTopN({ index, queryVector: Float32Array.from([1, 0]), limit: 2 })[0][0]).toBe('#1')
  })
})

describe('buildVectorIndex', () => {
  it('embeds misses once and reuses the cache on the next build', async () => {
    let calls = 0
    const embedder: Embedder = {
      modelId: 'c',
      embedDocuments: async (texts) => { calls += 1; return texts.map(() => Float32Array.from([1, 0])) },
      embedQuery: async (texts) => texts.map(() => Float32Array.from([1, 0])),
    }
    const store = inMemoryVectorCacheStore()
    const records = [rec({ sourceId: '#1', text: 'a' }), rec({ sourceId: '#2', text: 'b' })]
    const first = await buildVectorIndex({ records, embedder, store, persist: true })
    expect(first.ids).toEqual(['#1', '#2'])
    expect(calls).toBe(1)
    await buildVectorIndex({ records, embedder, store })
    expect(calls).toBe(1) // reused from cache, no re-embed
  })
})
