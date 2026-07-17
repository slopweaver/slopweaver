/**
 * Lazy manifest for the `dev` noun — repo-development verbs. `gate` is the composed PR gate; it loads
 * only when dispatched.
 */
import { lazy, type VerbManifestEntry } from '../manifest.js'

const gateMeta = {
  summary: 'Run the PR gate: hygiene + PR-format + eval-regression (single non-zero exit + a ledger)',
  usage: 'usage: slopweaver dev gate [--home <dir>] [--pr-body-file <path>]',
  example: 'slopweaver dev gate --pr-body-file pr.md',
} as const

const loadGate = () => import('../commands/dev/run.js').then((m) => m.devGateCommand)

export const devManifest: Readonly<Record<string, VerbManifestEntry>> = {
  gate: lazy({ meta: gateMeta, load: loadGate }),
}
