import { describe, expect, it } from 'vitest'
import { buildRetrievalIndex, search } from './retrievalIndex.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-01-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 't', refs: [], ...over,
})

const index = buildRetrievalIndex({ records: [
  rec({ sourceId: '#1', text: 'the authentication token flow' }),
  rec({ sourceId: '#2', text: 'unrelated deployment pipeline' }),
  rec({ sourceId: '#3', text: 'more authentication details here' }),
] })

describe('search', () => {
  it('ranks records matching the query terms first', () => {
    const ids = search({ index, query: 'authentication', limit: 10 })
    expect(ids).toContain('#1')
    expect(ids).toContain('#3')
    expect(ids).not.toContain('#2')
  })

  it('fails closed to [] on a negative limit', () => {
    expect(search({ index, query: 'authentication', limit: -1 })).toEqual([])
  })
})
