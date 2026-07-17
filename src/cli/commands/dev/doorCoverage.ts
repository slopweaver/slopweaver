/**
 * `slopweaver dev door-coverage` — the bypass guard. Prints every direct side-effect seam classed as a
 * sanctioned local-state / transport / read-only seam vs an `open` (un-accounted) one, plus any verb that
 * fails to declare its effect or routes an external write around the door. Exits non-zero on ANY open seam
 * or verb gap, so a green board can never hide a bypass. Read-only diagnostic.
 */
import { logger } from '../../../lib/logger.js'
import { coverageReport } from '../../../admit/coverage.js'
import { defineCommand } from '../../defineCommand.js'
import { EXIT_ERROR, EXIT_OK } from '../../exitCodes.js'

const USAGE = 'usage: slopweaver dev door-coverage [--json]'

/** Percent of direct seams that are accounted for (sanctioned); 100 when there are none. */
function coveragePercent({ total, open }: { total: number; open: number }): number {
  return total === 0 ? 100 : Math.round(((total - open) / total) * 100)
}

/**
 * Run the door-coverage verb.
 *
 * @param argv the full process argv
 * @returns EXIT_OK when every seam is accounted for, else EXIT_ERROR (a reported finding)
 */
export function runDoorCoverage(argv: readonly string[]): number {
  const rest = argv.slice(3)
  if (rest.includes('--help') || rest.includes('-h')) {
    logger.out(USAGE)
    return EXIT_OK
  }
  const report = coverageReport()
  const percent = coveragePercent({ total: report.seams.length, open: report.open.length })

  if (rest.includes('--json')) {
    logger.out(JSON.stringify({
      ok: report.ok,
      coveragePercent: percent,
      seams: report.seams.length,
      open: report.open,
      verbGaps: report.verbGaps,
    }, null, 2))
    return report.ok ? EXIT_OK : EXIT_ERROR
  }

  logger.out(`door coverage: ${String(percent)}% of ${String(report.seams.length)} direct seams accounted for`)
  if (report.open.length > 0) {
    logger.out(`\n${String(report.open.length)} OPEN seam(s) — not routed through the door + not a sanctioned local-state seam:`)
    for (const seam of report.open) {
      logger.out(`  ${seam.file}:${String(seam.line)} [${seam.seam}]`)
    }
  }
  if (report.verbGaps.length > 0) {
    logger.out(`\n${String(report.verbGaps.length)} verb gap(s):`)
    for (const gap of report.verbGaps) {
      logger.out(`  ${gap.noun} ${gap.verb} — ${gap.reason}`)
    }
  }
  logger.out(report.ok ? '\ndoor coverage: OK (every seam accounted for)' : '\ndoor coverage: FAIL (see above)')
  return report.ok ? EXIT_OK : EXIT_ERROR
}

export const doorCoverageCommand = defineCommand({
  summary: 'Prove every side-effect seam is routed through the door (or an acknowledged local-state seam)',
  usage: USAGE,
  example: 'slopweaver dev door-coverage --json',
  effect: 'none',
  parseRejectIsIoFree: true,
  diagnostic: true,
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  run: runDoorCoverage,
})
