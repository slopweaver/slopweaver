import { describe, expect, it } from 'vitest'
import { prepareSemanticContext } from './semanticRetrieval.js'
import { fakeConceptEmbedder } from './fakeEmbedder.js'
import { inMemoryVectorCacheStore } from './vectorIndex.js'
import type { Embedder } from './embeddings.js'
import type { CorpusRecord } from '../corpus/types.js'

const records: readonly CorpusRecord[] = [
  { source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-01-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 'login token', refs: [] },
]
const deps = { embedder: fakeConceptEmbedder, store: inMemoryVectorCacheStore() }

describe('prepareSemanticContext', () => {
  it('returns no context (not degraded) when disabled', async () => {
    const prep = await prepareSemanticContext({ records, query: 'q', deps, enabled: false })
    expect(prep).toEqual({ degraded: false })
  })

  it('builds a context with the fake embedder', async () => {
    const prep = await prepareSemanticContext({ records, query: 'login', deps, enabled: true })
    expect(prep.degraded).toBe(false)
    expect(prep.context?.queryVector).toBeDefined()
  })

  it('degrades loudly when the embedder throws', async () => {
    const warns: string[] = []
    const broken: Embedder = {
      modelId: 'x',
      embedDocuments: async () => { throw new Error('no model') },
      embedQuery: async () => { throw new Error('no model') },
    }
    const prep = await prepareSemanticContext({ records, query: 'q', deps: { embedder: broken, store: inMemoryVectorCacheStore() }, enabled: true, warn: (m) => warns.push(m) })
    expect(prep.degraded).toBe(true)
    expect(warns[0]).toContain('falling back to BM25-only')
  })
})
