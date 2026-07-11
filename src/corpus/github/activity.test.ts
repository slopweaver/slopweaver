import { describe, expect, it } from 'vitest'
import { makeFetchGithubActivity, parseActivity } from './activity.js'
import { unwrap } from '../../lib/result.js'

const prNode = {
  state: 'OPEN',
  isDraft: false,
  updatedAt: '2024-01-02T00:00:00Z',
  reviewDecision: 'APPROVED',
  mergeable: 'MERGEABLE',
  commits: { nodes: [{ commit: { statusCheckRollup: { state: 'SUCCESS' } } }] },
  reviews: { nodes: [{ author: { login: 'rev' }, state: 'APPROVED', submittedAt: '2024-01-01T10:00:00Z', url: 'u1', body: 'lgtm' }] },
  comments: { nodes: [{ author: { login: 'c1' }, createdAt: '2024-01-01T11:00:00Z', url: 'u2', body: 'a comment' }] },
  reviewThreads: { nodes: [{ isResolved: true, comments: { nodes: [{ author: { login: 'c2' }, createdAt: '2024-01-01T12:00:00Z', url: 'u3', body: 'thread' }] } }] },
  timelineItems: { nodes: [{ __typename: 'MergedEvent', createdAt: '2024-01-02T00:00:00Z', actor: { login: 'merger' } }] },
}

describe('parseActivity', () => {
  it('parses a PR node — reviews, issue+thread comments, checks, timeline', () => {
    const activity = parseActivity({ node: prNode, isPr: true })
    expect(activity.state).toBe('OPEN')
    expect(activity.checks).toBe('SUCCESS')
    expect(activity.reviews).toHaveLength(1)
    expect(activity.comments).toHaveLength(2)
    expect(activity.comments[1].resolved).toBe(true)
    expect(activity.timeline).toEqual([{ type: 'Merged', tsIso: '2024-01-02T00:00:00Z', actor: 'merger' }])
  })

  it('an issue node carries no reviews and degrades missing fields to empty', () => {
    const activity = parseActivity({ node: { state: 'CLOSED', comments: { nodes: [] } }, isPr: false })
    expect(activity.reviews).toEqual([])
    expect(activity.checks).toBeUndefined()
    expect(activity.comments).toEqual([])
  })
})

describe('makeFetchGithubActivity', () => {
  const repo = { owner: 'o', repo: 'r' }

  it('returns the parsed activity for a present node', async () => {
    const fetch = makeFetchGithubActivity({ graphql: async () => ({ repository: { pullRequest: prNode } }) })
    const result = await fetch({ repo, number: 1, isPr: true })
    expect(result.ok).toBe(true)
    expect(unwrap(result).checks).toBe('SUCCESS')
  })

  it('errs (not throws) when the item is absent', async () => {
    const fetch = makeFetchGithubActivity({ graphql: async () => ({ repository: { pullRequest: null } }) })
    expect((await fetch({ repo, number: 9, isPr: true })).ok).toBe(false)
  })

  it('errs when the transport throws', async () => {
    const fetch = makeFetchGithubActivity({ graphql: async () => { throw new Error('rate limited') } })
    expect((await fetch({ repo, number: 1, isPr: true })).ok).toBe(false)
  })
})
