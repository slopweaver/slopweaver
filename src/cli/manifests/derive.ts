/**
 * Lazy manifest for the `derive` noun — bare-noun + `run` share one loader, so the module loads only
 * when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from '../manifest.js'

const deriveMeta = {
  summary: 'Derive deterministic silver (directory + graph + opportunities) from the corpus',
  usage: 'usage: slopweaver derive [--home <dir>] [--corpus <dir>] [--top N] [--dry-run]',
  effect: 'local-state',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  example: 'slopweaver derive',
  parseRejectIsIoFree: false,
  diagnostic: false,
} as const

const loadDerive = () => import('../commands/derive/run.js').then((m) => m.deriveRunCommand)

export const deriveManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ meta: deriveMeta, load: loadDerive }),
  run: lazy({ meta: deriveMeta, load: loadDerive }),
}
