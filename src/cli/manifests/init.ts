/**
 * Lazy manifest for the `init` noun. Bare-noun and `run` verb share one loader, so enumeration stays
 * import-free and the command module loads only when `init` is dispatched.
 */
import { lazy, type VerbManifestEntry } from '../manifest.js'

const initMeta = {
  summary: 'Scaffold $SLOPWEAVER_HOME (idempotent): corpus/beliefs/ledgers dirs + seed files',
  usage: 'usage: slopweaver init [--home <dir>]',
  example: 'slopweaver init',
  parseRejectIsIoFree: true,
} as const

const loadInit = () => import('../commands/init/run.js').then((m) => m.initRunCommand)

export const initManifest: Readonly<Record<string, VerbManifestEntry>> = {
  '': lazy({ meta: initMeta, load: loadInit }),
  run: lazy({ meta: initMeta, load: loadInit }),
}
