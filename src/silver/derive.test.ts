import { describe, expect, it } from 'vitest'
import { deriveSilver, planDeriveSummary } from './derive.js'
import { buildIdentityMap } from './identity.js'
import type { CorpusRecord } from '../corpus/types.js'

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  source: 'github', sourceId: '#1', url: 'u', tsIso: '2024-06-01T00:00:00Z', kind: 'pr', container: 'o/r', text: 't', refs: [], ...over,
})

const emptyMap = buildIdentityMap({ records: [] })

describe('deriveSilver', () => {
  it('builds directory + graph + opportunities from the corpus', () => {
    const artifacts = deriveSilver({
      records: [rec({ sourceId: '#1', author: 'alice', url: 'u1', refs: ['#42'] }), rec({ sourceId: '#2', url: 'u2', refs: ['#42'] })],
      identityMap: emptyMap,
    })
    expect(artifacts.directory.people.some((p) => p.id === 'alice')).toBe(true)
    expect(artifacts.graph.edges).toHaveLength(1)
    expect(Array.isArray(artifacts.opportunities)).toBe(true)
  })
})

describe('planDeriveSummary', () => {
  it('leads with the directory/graph/opportunity counts', () => {
    const artifacts = deriveSilver({ records: [rec()], identityMap: emptyMap })
    const lines = planDeriveSummary({ artifacts, top: 5 })
    expect(lines[0]).toContain('directory:')
    expect(lines[1]).toContain('graph:')
  })
})
