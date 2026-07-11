import { describe, expect, it } from 'vitest'
import { buildGoldDocs } from './goldIndex.js'
import type { SourceDigest } from './distil.js'
import type { DirectoryEntry } from '../silver/directory.js'
import type { Opportunity } from '../silver/opportunity.js'

const person: DirectoryEntry = { id: 'alice', kind: 'person', recordCount: 2, sources: ['github'] }
const container: DirectoryEntry = { id: 'o/r', kind: 'container', recordCount: 5, sources: ['github'] }
const sourceDigest: SourceDigest = {
  source: 'github', recordCount: 5,
  containers: [{ source: 'github', container: 'o/r', summary: 'shipped auth', points: [{ point: 'merged the login PR', citations: ['pr-url'] }] }],
}
const crossCut: Opportunity = { kind: 'cross-cutting', subject: 'TEAM-1', evidence: ['u'], score: 3, summary: 'TEAM-1 is referenced across 3 distinct containers' }

describe('buildGoldDocs', () => {
  const docs = buildGoldDocs({ people: [person], containers: [container], sources: [sourceDigest], opportunities: [crossCut], builtAtIso: '2024-06-01T00:00:00Z' })
  const byPath = (path: string): string => docs.find((d) => d.path === path)!.markdown

  it('renders overview, per-source, and where-to-look docs', () => {
    expect(docs.map((d) => d.path).sort()).toEqual(['by-source/github.md', 'overview.md', 'where-to-look.md'])
  })

  it('overview names the source and the cross-cutting concern', () => {
    const overview = byPath('overview.md')
    expect(overview).toContain('**github**')
    expect(overview).toContain('TEAM-1 is referenced across 3 distinct containers')
  })

  it('by-source carries the container summary and its grounded point', () => {
    const bySource = byPath('by-source/github.md')
    expect(bySource).toContain('shipped auth')
    expect(bySource).toContain('merged the login PR')
    expect(bySource).toContain('pr-url')
  })
})
