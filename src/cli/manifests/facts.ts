/**
 * Lazy manifest for the `facts` noun — bare-noun + `run` share one loader.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from '../manifest.js'

const factsMeta = {
  summary: 'Retrieve the ranked record slice for a question (no LLM)',
  usage: 'usage: slopweaver facts <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--home <dir>] [--corpus <dir>]',
  effect: 'local-state',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  example: 'slopweaver facts "auth flow"',
  parseRejectIsIoFree: false,
  diagnostic: false,
} as const

const loadFacts = () => import('../commands/facts/run.js').then((m) => m.factsRunCommand)

export const factsManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ meta: factsMeta, load: loadFacts }),
  run: lazy({ meta: factsMeta, load: loadFacts }),
}
