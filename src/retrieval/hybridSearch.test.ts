import { describe, expect, it } from 'vitest'
import { hybridSearch } from './hybridSearch.js'
import { buildRetrievalIndex } from './retrievalIndex.js'
import type { VectorIndex } from './vectorIndex.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-01-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 't', refs: [], ...over,
})

const index = buildRetrievalIndex({ records: [
  rec({ sourceId: '#1', text: 'authentication token flow' }),
  rec({ sourceId: '#2', text: 'deployment pipeline release' }),
] })

describe('hybridSearch', () => {
  it('fails soft to BM25-only when no vector index is given', () => {
    expect(hybridSearch({ index, query: 'authentication', limit: 10 })).toEqual(['#1'])
  })

  it('lets a strong semantic match surface a lexically-weak doc', () => {
    const vectorIndex: VectorIndex = { ids: ['#1', '#2'], vectors: [Float32Array.from([1, 0]), Float32Array.from([0, 1])] }
    const ranked = hybridSearch({ index, query: 'authentication', queryVector: Float32Array.from([0, 1]), vectorIndex, limit: 10, alpha: 1 })
    expect(ranked[0]).toBe('#2')
  })
})
