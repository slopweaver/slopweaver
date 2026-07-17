/**
 * Lazy manifest for the `dev` noun — repo-development verbs. `gate` is the composed PR gate;
 * `door-coverage` proves no side-effect seam bypasses the door; `door` demonstrates the admit pathway.
 * Each loads only when dispatched.
 */
import { lazy, type VerbManifestEntry } from '../manifest.js'

const gateMeta = {
  summary: 'Run the PR gate: hygiene + PR-format + eval-regression (single non-zero exit + a ledger)',
  usage: 'usage: slopweaver dev gate [--home <dir>] [--pr-body-file <path>]',
  effect: 'local-state',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  example: 'slopweaver dev gate --pr-body-file pr.md',
  parseRejectIsIoFree: false,
  diagnostic: false,
} as const

const doorCoverageMeta = {
  summary: 'Prove every side-effect seam is routed through the door (or an acknowledged local-state seam)',
  usage: 'usage: slopweaver dev door-coverage [--json]',
  effect: 'none',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  example: 'slopweaver dev door-coverage --json',
  parseRejectIsIoFree: true,
  diagnostic: true,
} as const

const doorMeta = {
  summary: 'Exercise the admit door: --simulate warn|pass|hold, or --raw "<cmd>" to test the raw-tool block',
  usage: 'usage: slopweaver dev door (--simulate warn|pass|hold | --raw "<command>") [--home <dir>]',
  effect: 'local-state',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  example: 'slopweaver dev door --simulate warn',
  parseRejectIsIoFree: false,
  diagnostic: false,
} as const

const loadGate = () => import('../commands/dev/run.js').then((m) => m.devGateCommand)
const loadDoorCoverage = () => import('../commands/dev/doorCoverage.js').then((m) => m.doorCoverageCommand)
const loadDoor = () => import('../commands/dev/door.js').then((m) => m.doorCommand)

export const devManifest: Readonly<Record<string, VerbManifestEntry>> = {
  gate: lazy({ meta: gateMeta, load: loadGate }),
  'door-coverage': lazy({ meta: doorCoverageMeta, load: loadDoorCoverage }),
  door: lazy({ meta: doorMeta, load: loadDoor }),
}
