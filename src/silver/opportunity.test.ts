import { describe, expect, it } from 'vitest'
import { spotOpportunities } from './opportunity.js'
import type { CorpusRecord } from '../corpus/types.js'

const T = '2024-06-01T00:00:00Z'
const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: T, kind: 'pr', container: 'o/r', text: 't', refs: [], ...over,
})

describe('spotOpportunities', () => {
  it('flags a cross-cutting reference spanning ≥3 containers', () => {
    const opps = spotOpportunities({
      records: [
        rec({ sourceId: '#1', container: 'c1', refs: ['TEAM-1'] }),
        rec({ sourceId: '#2', container: 'c2', refs: ['TEAM-1'] }),
        rec({ sourceId: '#3', container: 'c3', refs: ['TEAM-1'] }),
      ],
      edges: [],
    })
    const crossCut = opps.find((o) => o.kind === 'cross-cutting' && o.subject === 'TEAM-1')!
    expect(crossCut.summary).toContain('3 distinct containers')
  })

  it('flags a referenced, unresolved item as a blocker', () => {
    const opps = spotOpportunities({
      records: [
        rec({ sourceId: '#10', container: 'c1', text: 'this is blocked on review' }),
        rec({ sourceId: '#11', container: 'c2', refs: ['#10'] }),
      ],
      edges: [],
    })
    expect(opps.some((o) => o.kind === 'blocker' && o.subject === '#10')).toBe(true)
  })

  it('does not flag duplication within a single source', () => {
    const opps = spotOpportunities({
      records: [
        rec({ sourceId: '#1', title: 'Fix login' }),
        rec({ sourceId: '#2', title: 'Fix login' }),
      ],
      edges: [],
    })
    expect(opps.some((o) => o.kind === 'duplication')).toBe(false)
  })
})
