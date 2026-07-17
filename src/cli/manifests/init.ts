/**
 * Lazy manifest for the `init` noun. Bare-noun and `run` verb share one loader, so enumeration stays
 * import-free and the command module loads only when `init` is dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from '../manifest.js'

const initMeta = {
  summary: 'Scaffold $SLOPWEAVER_HOME (idempotent): corpus/beliefs/ledgers dirs + seed files',
  usage: 'usage: slopweaver init [--home <dir>]',
  effect: 'local-state',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  example: 'slopweaver init',
  parseRejectIsIoFree: true,
  diagnostic: false,
} as const

const loadInit = () => import('../commands/init/run.js').then((m) => m.initRunCommand)

export const initManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ meta: initMeta, load: loadInit }),
  run: lazy({ meta: initMeta, load: loadInit }),
}
