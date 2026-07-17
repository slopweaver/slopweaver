/**
 * `slopweaver doctor` — the env preflight. Prints the plugin version, the resolved state home, its layout
 * version, and the presence/emptiness of each part of the home (corpus roots, beliefs, ledgers, identity,
 * profile, denylist). Read-only: it reports status, it never scaffolds (that is `slopweaver init`) and it
 * never prints identity/profile CONTENTS — only whether they parse. All paths come from `stateHomePaths`.
 *
 * v0.1 has no hard native dependencies, so a healthy env exits 0; the `diagnostic` meta reserves the
 * non-zero-is-a-finding channel for the probes later PRs add.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { isRecord } from '../../../lib/parsers.js'
import { readJsonFile } from '../../../lib/jsonFile.js'
import { logger } from '../../../lib/logger.js'
import { parseProfile } from '../../../profile.js'
import { stateHomePaths } from '../../../stateHome.js'
import { defineCommand } from '../../defineCommand.js'
import { EXIT_OK } from '../../exitCodes.js'

const USAGE = 'usage: slopweaver doctor'

/** Read the plugin version from the package manifest at the repo root (resolves identically under tsx + dist). */
function pluginVersion(): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(new URL('../../../../package.json', import.meta.url), 'utf8'))
    return isRecord(parsed) && typeof parsed.version === 'string' ? parsed.version : 'unknown'
  } catch {
    return 'unknown'
  }
}

/** `exists` + `(empty)` when a present directory has no entries — reveals scaffolded-but-unpopulated dirs. */
function dirStatus({ path }: { path: string }): string {
  if (!existsSync(path)) {
    return 'missing'
  }
  try {
    return readdirSync(path).length === 0 ? 'exists (empty)' : 'exists'
  } catch {
    return 'exists'
  }
}

/** The home-version marker's value, or a not-initialised note. */
function homeVersionLine({ path }: { path: string }): string {
  const parsed = readJsonFile({ path })
  if (isRecord(parsed) && typeof parsed.version === 'number') {
    return `home version: ${String(parsed.version)}`
  }
  return 'home version: not initialised — run `slopweaver init`'
}

/** Parse-status of profile.json: missing / valid / invalid (with the reason), never its contents. */
function profileLine({ path }: { path: string }): string {
  if (!existsSync(path)) {
    return 'profile.json: missing — run `slopweaver init`'
  }
  const result = parseProfile({ value: readJsonFile({ path }) })
  return result.ok ? 'profile.json: present (valid)' : `profile.json: present (INVALID: ${result.errors.join('; ')})`
}

/** Parse-status of identity.json: the identity map is a JSON array; report present/valid/invalid only. */
function identityLine({ path }: { path: string }): string {
  if (!existsSync(path)) {
    return 'identity.json: missing — run `slopweaver init`'
  }
  return Array.isArray(readJsonFile({ path })) ? 'identity.json: present (valid)' : 'identity.json: present (INVALID: not a JSON array)'
}

/**
 * Build the doctor report lines for a specific home. Does read-only fs probes against `home` (no writes),
 * so it is exercised by a fixture round-trip test without any mock.
 *
 * @param home the state home to report on
 * @param envHome the raw `$SLOPWEAVER_HOME` (for the "unset — using default" line), or undefined
 * @param version the plugin version string
 * @returns the report lines, in display order
 */
export function doctorReport({ home, envHome, version }: { home: string; envHome: string | undefined; version: string }): readonly string[] {
  const paths = stateHomePaths({ home })
  const lines = [
    `slopweaver v${version}`,
    `SLOPWEAVER_HOME: ${envHome !== undefined && envHome.length > 0 ? envHome : `unset — using default ${paths.root}`}`,
    homeVersionLine({ path: paths.homeVersion }),
    `corpus: bronze ${dirStatus({ path: paths.corpus.bronze })} · silver ${dirStatus({ path: paths.corpus.silver })} · gold ${dirStatus({ path: paths.corpus.gold })}`,
    `beliefs: ${dirStatus({ path: paths.beliefs })}`,
    `ledgers: ${dirStatus({ path: paths.ledgers })}`,
    identityLine({ path: paths.identityJson }),
    profileLine({ path: paths.profileJson }),
    `hygiene-denylist.txt: ${existsSync(paths.hygieneDenylist) ? 'present' : 'missing (no private denylist)'}`,
  ]
  // A pre-rename home has an orphaned `warehouse/`; the medallion root is `corpus/` now. Heads-up, not a fault.
  if (existsSync(join(paths.root, 'warehouse'))) {
    lines.push('note: a legacy `warehouse/` dir is present — the corpus root is now `corpus/`; re-run refresh/derive/distil to repopulate it.')
  }
  lines.push('ok')
  return lines
}

export function runDoctor(argv: readonly string[]): number {
  const rest = argv.slice(3)
  if (rest.includes('--help') || rest.includes('-h')) {
    logger.out(USAGE)
    return EXIT_OK
  }
  const envHome = process.env.SLOPWEAVER_HOME
  for (const line of doctorReport({ home: stateHomePaths().root, envHome, version: pluginVersion() })) {
    logger.out(line)
  }
  return EXIT_OK
}

export const doctorRunCommand = defineCommand({
  summary: 'Env preflight: plugin version + the resolved state home and its layout',
  usage: USAGE,
  example: 'slopweaver doctor',
  parseRejectIsIoFree: true,
  diagnostic: true,
  effect: 'none',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  run: runDoctor,
})
