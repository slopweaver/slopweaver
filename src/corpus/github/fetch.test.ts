import { describe, expect, it } from 'vitest'
import { makeGithubFetchItems, type SearchIssues } from './fetch.js'
import type { GithubActivity } from './activity.js'
import { err, ok, type Result, unwrap } from '../../lib/result.js'

const repo = { owner: 'o', repo: 'r' }
const window = { since: '2024-01-01', until: '2024-01-03' }

const hit = ({ n, isPr }: { n: number; isPr: boolean }): unknown => ({
  number: n, title: `t${String(n)}`, html_url: `url${String(n)}`,
  created_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-02T00:00:00Z',
  user: { login: 'u' }, ...(isPr ? { pull_request: {} } : {}),
})

/** page 1 returns `items`, later pages are empty (a short page stops the loop). */
const search = (items: readonly unknown[]): SearchIssues =>
  async ({ page }) => ({ data: { items: page === 1 ? items : [] } })

const activityStub: GithubActivity = {
  state: 'OPEN', updatedAtIso: '2024-01-02T00:00:00Z', reviews: [], comments: [], timeline: [],
}

describe('makeGithubFetchItems', () => {
  it('maps hits to items, discriminating PR vs issue', async () => {
    const fetchItems = makeGithubFetchItems({ searchIssues: search([hit({ n: 1, isPr: true }), hit({ n: 2, isPr: false })]) })
    const result = await fetchItems({ repo, window })
    expect(unwrap(result).map((i) => i.kind)).toEqual(['pr', 'issue'])
  })

  it('attaches activity on enrich success and ships the item bare on enrich failure', async () => {
    const fetchActivity = async ({ number }: { number: number }): Promise<Result<GithubActivity>> =>
      number === 1 ? ok(activityStub) : err(['no activity'])
    const fetchItems = makeGithubFetchItems({ searchIssues: search([hit({ n: 1, isPr: true }), hit({ n: 2, isPr: true })]), fetchActivity })
    const items = unwrap(await fetchItems({ repo, window }))
    expect(items[0].activity).toBeDefined()
    expect(items[1].activity).toBeUndefined()
  })

  it('a search failure is fatal (err), not a partial write', async () => {
    const fetchItems = makeGithubFetchItems({ searchIssues: async () => { throw new Error('boom') } })
    expect((await fetchItems({ repo, window })).ok).toBe(false)
  })

  it('honours the page cap', async () => {
    const items = [hit({ n: 1, isPr: true }), hit({ n: 2, isPr: true }), hit({ n: 3, isPr: true })]
    const fetchItems = makeGithubFetchItems({ searchIssues: search(items), pageCap: 2 })
    expect(unwrap(await fetchItems({ repo, window }))).toHaveLength(2)
  })
})
