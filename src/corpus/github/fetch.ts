/**
 * The impure GitHub edge. Two lanes: REST **search** discovers the PRs/issues touched in a window
 * (poll-by-`updated` so an old item edited inside the window re-surfaces), then the GraphQL **activity**
 * lane enriches each. Network is confined here; discovery + enrichment are injected seams
 * (`SearchIssues`, `FetchGithubActivity`) so the whole orchestration is unit-testable with fakes, and
 * `fetch.ts` is the only module that constructs a live client.
 *
 * Search is capped at GitHub's hard 1000-result / 10-page ceiling; a caller wanting more must window
 * finer. Per-item enrichment failures are swallowed — the atom still ships without its activity — so one
 * bad item never sinks a refresh. A search failure, by contrast, is fatal (returned as `err`): we never
 * silently persist a partial window.
 */
import { Octokit } from '@octokit/rest'
import { retry } from '@octokit/plugin-retry'
import { throttling } from '@octokit/plugin-throttling'

import { isRecord } from '../../lib/parsers.js'
import { err, ok, type Result } from '../../lib/result.js'
import type { Repository } from '../../config.js'
import type { ExportWindow } from '../types.js'
import { type FetchGithubActivity, makeFetchGithubActivity } from './activity.js'
import type { GithubExportItem } from './project.js'

const PER_PAGE = 100
const MAX_PAGES = 10
const DEFAULT_PAGE_CAP = 1000
const MAX_RETRIES = 3

/** Fetch every in-window item for a repo. `err` only on a hard search failure (never partial). */
export type FetchGithubItems =
  (input: { repo: Repository; window: ExportWindow }) => Promise<Result<readonly GithubExportItem[]>>

/** Progress callback fired once per enriched item. */
export type FetchProgress = (progress: { number: number; index: number; total: number }) => void

interface SearchArgs {
  readonly q: string
  readonly sort: 'updated'
  readonly order: 'desc'
  readonly per_page: number
  readonly page: number
}

/** Injected REST search seam. Items are parsed defensively, so the raw shape stays `unknown`. */
export type SearchIssues = (args: SearchArgs) => Promise<{ data: { items: readonly unknown[] } }>

export interface FetchItemsDeps {
  readonly searchIssues: SearchIssues
  /** Absent ⇒ discovery only, no enrichment (atoms carry no reviews/comments/state). */
  readonly fetchActivity?: FetchGithubActivity
  readonly pageCap?: number
  readonly onProgress?: FetchProgress
}

/** Coerce an unknown to a non-empty string, or `undefined`. */
function optStr({ value }: { value: unknown }): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/** Defensively shape one raw search hit into an item; `undefined` when it lacks a usable number. */
function toExportItem({ raw }: { raw: unknown }): GithubExportItem | undefined {
  if (!isRecord(raw) || typeof raw.number !== 'number') {
    return undefined
  }
  const isPr = isRecord(raw.pull_request)
  const author = isRecord(raw.user) ? optStr({ value: raw.user.login }) : undefined
  const body = optStr({ value: raw.body })
  return {
    number: raw.number,
    kind: isPr ? 'pr' : 'issue',
    title: optStr({ value: raw.title }) ?? '',
    url: optStr({ value: raw.html_url }) ?? '',
    tsIso: optStr({ value: raw.updated_at }) ?? optStr({ value: raw.created_at }) ?? '',
    ...(author !== undefined ? { author } : {}),
    ...(body !== undefined ? { body } : {}),
  }
}

/** Page through search until a short page or the cap. A thrown search error is fatal → `err`. */
async function searchAll(
  { searchIssues, q, pageCap }: { searchIssues: SearchIssues; q: string; pageCap: number },
): Promise<Result<GithubExportItem[]>> {
  const items: GithubExportItem[] = []
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    let hits: readonly unknown[]
    try {
      const res = await searchIssues({ q, sort: 'updated', order: 'desc', per_page: PER_PAGE, page })
      hits = res.data.items
    } catch (error: unknown) {
      return err([error instanceof Error ? error.message : 'github search failed'])
    }
    for (const raw of hits) {
      const item = toExportItem({ raw })
      if (item !== undefined) {
        items.push(item)
      }
    }
    if (hits.length < PER_PAGE || items.length >= pageCap) {
      break
    }
  }
  return ok(items.slice(0, pageCap))
}

/** Enrich each item; a per-item failure ships the item without activity (never fatal). */
async function enrichAll(
  { items, repo, fetchActivity, onProgress }:
  { items: readonly GithubExportItem[]; repo: Repository; fetchActivity: FetchGithubActivity; onProgress?: FetchProgress },
): Promise<GithubExportItem[]> {
  const enriched: GithubExportItem[] = []
  for (const [index, item] of items.entries()) {
    const result = await fetchActivity({ repo, number: item.number, isPr: item.kind === 'pr' })
    enriched.push(result.ok ? { ...item, activity: result.value } : item)
    onProgress?.({ number: item.number, index: index + 1, total: items.length })
  }
  return enriched
}

/**
 * Build a `FetchGithubItems` over injected seams. This is what tests use.
 *
 * @param deps the search seam, optional enrichment seam, page cap, and progress callback
 * @returns a repo+window fetcher
 */
export function makeGithubFetchItems(deps: FetchItemsDeps): FetchGithubItems {
  const pageCap = deps.pageCap ?? DEFAULT_PAGE_CAP
  return async ({ repo, window }) => {
    const q = `repo:${repo.owner}/${repo.repo} updated:${window.since}..${window.until}`
    const searched = await searchAll({ searchIssues: deps.searchIssues, q, pageCap })
    if (searched.ok === false) {
      return searched
    }
    if (deps.fetchActivity === undefined) {
      return ok(searched.value)
    }
    return ok(await enrichAll({
      items: searched.value,
      repo,
      fetchActivity: deps.fetchActivity,
      ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
    }))
  }
}

const ResilientOctokit = Octokit.plugin(retry, throttling)

/** A retry- + throttle-resilient client bound to `token` (undefined ⇒ unauthenticated, public only). */
function makeClient({ token }: { token: string | undefined }): InstanceType<typeof ResilientOctokit> {
  return new ResilientOctokit({
    auth: token,
    throttle: {
      onRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount < MAX_RETRIES,
      onSecondaryRateLimit: (_retryAfter, _options, _octokit, retryCount) => retryCount < MAX_RETRIES,
    },
  })
}

/**
 * Production `FetchGithubItems`: a live client, with GraphQL enrichment unless `enrich` is false.
 *
 * @param token the GitHub token (undefined ⇒ unauthenticated; GraphQL enrichment is unavailable)
 * @param enrich whether to enrich items via GraphQL (default true)
 * @param onProgress optional per-item progress callback
 * @returns a repo+window fetcher backed by a live client
 */
export function githubFetchItems(
  { token, enrich = true, onProgress }: { token?: string; enrich?: boolean; onProgress?: FetchProgress },
): FetchGithubItems {
  const client = makeClient({ token })
  const searchIssues: SearchIssues = async (args) => {
    const res = await client.rest.search.issuesAndPullRequests({
      q: args.q, sort: args.sort, order: args.order, per_page: args.per_page, page: args.page,
    })
    return { data: { items: res.data.items } }
  }
  const fetchActivity = enrich
    ? makeFetchGithubActivity({ graphql: (query, variables) => client.graphql(query, variables) })
    : undefined
  return makeGithubFetchItems({
    searchIssues,
    ...(fetchActivity !== undefined ? { fetchActivity } : {}),
    ...(onProgress !== undefined ? { onProgress } : {}),
  })
}
