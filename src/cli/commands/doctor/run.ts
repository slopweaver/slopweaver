/**
 * `slopweaver doctor` — the env preflight. Prints the plugin version, the resolved `SLOPWEAVER_HOME`
 * (or `unset`), and `ok`. v0.1 has no hard native dependencies, so it never exits non-zero on a healthy
 * env; the `diagnostic` meta reserves the non-zero-is-a-finding channel for the probes later PRs add.
 */
import { readFileSync } from 'node:fs'

import { isRecord } from '../../../lib/parsers.js'
import { logger } from '../../../lib/logger.js'
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

export function runDoctor(argv: readonly string[]): number {
  const rest = argv.slice(3)
  if (rest.includes('--help') || rest.includes('-h')) {
    logger.out(USAGE)
    return EXIT_OK
  }
  const home = process.env.SLOPWEAVER_HOME
  logger.out(`slopweaver v${pluginVersion()}`)
  logger.out(`SLOPWEAVER_HOME: ${home !== undefined && home.length > 0 ? home : 'unset'}`)
  logger.out('ok')
  return EXIT_OK
}

export const doctorRunCommand = defineCommand({
  summary: 'Env preflight: print the plugin version + resolved SLOPWEAVER_HOME',
  usage: USAGE,
  example: 'slopweaver doctor',
  parseRejectIsIoFree: true,
  diagnostic: true,
  run: runDoctor,
})
