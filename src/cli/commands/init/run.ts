/**
 * `slopweaver init` — scaffold `$SLOPWEAVER_HOME` idempotently. Creates the corpus/beliefs/ledgers dirs
 * and seeds the marker/seed files (home-version, identity, profile, denylist) without overwriting
 * anything that already exists. Safe to run repeatedly; run automatically on SessionStart.
 */
import { logger } from '../../../lib/logger.js'
import { defineCommand } from '../../defineCommand.js'
import { EXIT_OK, EXIT_USAGE } from '../../exitCodes.js'
import { runInit } from '../../../init/stateInit.js'

const USAGE = 'usage: slopweaver init [--home <dir>]'

/**
 * Run the init verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export function runInitCommand(argv: readonly string[]): number {
  const rest = argv.slice(3)
  if (rest.includes('--help') || rest.includes('-h')) {
    logger.out(USAGE)
    return EXIT_OK
  }
  const homeFlag = rest.indexOf('--home')
  let home: string | undefined
  if (homeFlag !== -1) {
    const value = rest[homeFlag + 1]
    if (value === undefined || value.startsWith('-')) {
      logger.error('init: --home needs a directory path')
      logger.error(USAGE)
      return EXIT_USAGE
    }
    home = value
  }

  const report = runInit(home !== undefined ? { home } : {})
  logger.out(`state home: ${report.home}`)
  for (const entry of report.entries) {
    const mark = entry.outcome === 'created' ? '+' : '·'
    logger.out(`  ${mark} ${entry.kind === 'dir' ? '[dir] ' : '[file]'} ${entry.path}`)
  }
  const created = report.entries.filter((e) => e.outcome === 'created').length
  logger.out(created === 0 ? 'already initialised (no changes)' : `initialised (${String(created)} created)`)
  return EXIT_OK
}

export const initRunCommand = defineCommand({
  summary: 'Scaffold $SLOPWEAVER_HOME (idempotent): corpus/beliefs/ledgers dirs + seed files',
  usage: USAGE,
  example: 'slopweaver init',
  // Parse rejects (`--home` with no value, unknown flags) exit before any write — the reject path is I/O-free.
  parseRejectIsIoFree: true,
  run: runInitCommand,
})
