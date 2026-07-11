import { describe, expect, it } from 'vitest'
import { buildCrossRefGraph } from './graph.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-01-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 't', refs: [], ...over,
})

describe('buildCrossRefGraph', () => {
  it('links two records that share a reference token', () => {
    const { nodes, edges } = buildCrossRefGraph({
      records: [
        rec({ sourceId: '#1', url: 'u1', refs: ['TEAM-9'] }),
        rec({ sourceId: '#2', url: 'u2', refs: ['TEAM-9'] }),
      ],
    })
    expect(nodes).toEqual(['github:#1', 'github:#2'])
    expect(edges).toHaveLength(1)
    expect(edges[0]).toEqual({ a: 'github:#1', b: 'github:#2', via: 'TEAM-9' })
  })

  it('produces no edge for a token held by a single record', () => {
    const { edges } = buildCrossRefGraph({ records: [rec({ url: 'solo', refs: ['ONLY-1'] })] })
    expect(edges).toEqual([])
  })
})
