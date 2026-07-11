import { describe, expect, it } from 'vitest'
import { type GithubExportItem, projectGithubRecords } from './project.js'
import type { GithubActivity } from './activity.js'

const activity: GithubActivity = {
  state: 'MERGED',
  isDraft: false,
  reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE',
  checks: 'SUCCESS',
  updatedAtIso: '2024-02-01T00:00:00Z',
  reviews: [{ author: 'rev', state: 'APPROVED', tsIso: '2024-01-31T00:00:00Z', url: 'r-url', body: 'lgtm' }],
  comments: [
    { author: 'c1', tsIso: '2024-01-30T00:00:00Z', url: 'c-url', body: 'nice work' },
    { author: 'c2', tsIso: '2024-01-30T01:00:00Z', url: 'c2-url', body: '', resolved: true },
  ],
  timeline: [{ type: 'Merged', tsIso: '2024-02-01T00:00:00Z', actor: 'merger' }],
}

const prItem: GithubExportItem = {
  number: 42, kind: 'pr', title: 'Add thing', url: 'pr-url',
  tsIso: '2024-01-29T00:00:00Z', author: 'alice', body: 'closes #7', activity,
}

describe('projectGithubRecords', () => {
  it('fans a PR into atom + review + comment + state records', () => {
    const ids = projectGithubRecords({ items: [prItem], repo: 'o/r' }).map((r) => r.sourceId)
    expect(ids).toContain('#42')
    expect(ids).toContain('#42:review:0')
    expect(ids).toContain('#42:comment:0')
    expect(ids).toContain('#42:state')
    // the empty-body comment (#42:comment:1) is skipped
    expect(ids).not.toContain('#42:comment:1')
  })

  it('builds a state-prefixed title, a gate summary, and refs on the atom', () => {
    const atom = projectGithubRecords({ items: [prItem], repo: 'o/r' }).find((r) => r.sourceId === '#42')!
    expect(atom.title).toBe('[MERGED] Add thing')
    expect(atom.text).toContain('Review: APPROVED')
    expect(atom.text).toContain('Checks: SUCCESS')
    expect(atom.tsIso).toBe('2024-02-01T00:00:00Z') // activity updatedAt wins
    expect(atom.refs).toContain('#7')
  })

  it('an item without activity yields just the atom with its raw body', () => {
    const bare: GithubExportItem = { number: 1, kind: 'issue', title: 'T', url: 'u', tsIso: '2024-01-01T00:00:00Z', body: 'hello' }
    const records = projectGithubRecords({ items: [bare], repo: 'o/r' })
    expect(records).toHaveLength(1)
    expect(records[0].text).toBe('hello')
    expect(records[0].title).toBe('T')
  })
})
