/**
 * `slopweaver refresh` — the bronze ingest. Resolves the target repo (from `--repo` or the git remote)
 * and a token (gh-first), computes an incremental window from the watermark, fetches + projects GitHub
 * activity into `CorpusRecord`s, writes them (redacted, deduped) to the bronze warehouse, and advances
 * the watermark. Derive/distil (silver/gold) are separate verbs; this one only fills bronze.
 *
 * GitHub's GraphQL API needs auth, so an unauthenticated run degrades to discovery-only (atoms without
 * reviews/comments) rather than firing a failing enrichment call per item.
 */
import { logger } from '../../../lib/logger.js'
import { defineCommand } from '../../defineCommand.js'
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from '../../exitCodes.js'
import { parseFlagTail, parsePositiveInteger } from '../../optionParsers.js'
import { githubToken, parseRepositorySlug, resolveRepository, slopweaverHome } from '../../../config.js'
import { githubFetchItems } from '../../../corpus/github/fetch.js'
import { projectGithubRecords } from '../../../corpus/github/project.js'
import { writeCorpusRecords } from '../../../corpus/corpusWriter.js'
import { bronzeDir } from '../../../corpus/corpusPaths.js'
import { advanceWatermark, computeSourceWatermarks, readWatermark, resolveSince } from '../../../corpus/watermark.js'
import type { ExportWindow } from '../../../corpus/types.js'

const USAGE = 'usage: slopweaver refresh [--repo owner/repo] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--lookback-days N] [--no-enrich]'

const DEFAULT_LOOKBACK_DAYS = 7

/** A UTC date `days` from today, as `YYYY-MM-DD`. */
function todayPlus({ days }: { days: number }): string {
  const date = new Date()
  date.setUTCDate(date.getUTCDate() + days)
  return date.toISOString().slice(0, 10)
}

/** `days` before a `YYYY-MM-DD` date, as `YYYY-MM-DD`. */
function isoMinusDays({ untilDate, days }: { untilDate: string; days: number }): string {
  const date = new Date(`${untilDate}T00:00:00Z`)
  date.setUTCDate(date.getUTCDate() - days)
  return date.toISOString().slice(0, 10)
}

/**
 * Run the refresh verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runRefresh(argv: readonly string[]): Promise<number> {
  const rest = argv.slice(3)
  if (rest.includes('--help') || rest.includes('-h')) {
    logger.out(USAGE)
    return EXIT_OK
  }
  const parsed = parseFlagTail({ rest, spec: { value: ['repo', 'since', 'until', 'lookback-days', 'home'], boolean: ['no-enrich'] } })
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => { logger.error(e) })
    logger.error(USAGE)
    return EXIT_USAGE
  }
  const { values, flags } = parsed.value

  const home = values.home ?? slopweaverHome()
  const repoResult = values.repo !== undefined ? parseRepositorySlug({ slug: values.repo }) : resolveRepository()
  if (repoResult.ok === false) {
    repoResult.errors.forEach((e) => { logger.error(e) })
    return EXIT_USAGE
  }
  const repo = repoResult.value

  const flagErrors: string[] = []
  const lookbackDays = values['lookback-days'] !== undefined
    ? parsePositiveInteger({ value: values['lookback-days'], label: '--lookback-days', errors: flagErrors })
    : DEFAULT_LOOKBACK_DAYS
  if (flagErrors.length > 0) {
    flagErrors.forEach((e) => { logger.error(e) })
    return EXIT_USAGE
  }

  const until = values.until ?? todayPlus({ days: 1 })
  const fallbackSince = isoMinusDays({ untilDate: until.slice(0, 10), days: lookbackDays })
  const since = values.since ?? resolveSince({ cursor: readWatermark({ source: 'github', home }), fallbackSince })
  const window: ExportWindow = { since, until }

  const token = githubToken()
  const enrich = !flags.has('no-enrich') && token !== undefined
  if (token === undefined) {
    logger.warn('no GitHub auth (set GITHUB_TOKEN or run `gh auth login`) — discovery-only, no reviews/comments')
  }
  logger.info(`refresh ${repo.owner}/${repo.repo} · window ${since}..${until}`)

  const fetchItems = githubFetchItems({
    ...(token !== undefined ? { token } : {}),
    enrich,
    onProgress: ({ number, index, total }) => { logger.info(`  enriched #${String(number)} (${String(index)}/${String(total)})`) },
  })
  const fetched = await fetchItems({ repo, window })
  if (fetched.ok === false) {
    fetched.errors.forEach((e) => { logger.error(e) })
    return EXIT_ERROR
  }

  const records = projectGithubRecords({ items: fetched.value, repo: `${repo.owner}/${repo.repo}` })
  if (records.length === 0) {
    logger.out(`no activity in ${since}..${until} for ${repo.owner}/${repo.repo}`)
    return EXIT_EXPECTED_EMPTY
  }

  const written = writeCorpusRecords({ records, window, home })
  if (written.ok === false) {
    written.errors.forEach((e) => { logger.error(e) })
    return EXIT_ERROR
  }

  const advanced = advanceWatermark({ watermarks: computeSourceWatermarks({ records, fallbackUntil: until }), home })
  if (advanced.ok === false) {
    advanced.errors.forEach((e) => { logger.error(e) })
    return EXIT_ERROR
  }

  const { written: newCount, deduped } = written.value
  logger.out(`wrote ${String(newCount)} new record(s), deduped ${String(deduped)}, from ${String(fetched.value.length)} item(s) → ${bronzeDir({ home })}`)
  return EXIT_OK
}

export const refreshRunCommand = defineCommand({
  summary: 'Ingest recent GitHub activity into the local bronze corpus',
  usage: USAGE,
  example: 'slopweaver refresh --repo octocat/Hello-World',
  run: runRefresh,
})
