/**
 * Lazy manifest for the `facts` noun — bare-noun + `run` share one loader.
 */
import { lazy, type VerbManifestEntry } from '../manifest.js'

const factsMeta = {
  summary: 'Retrieve the ranked record slice for a question (no LLM)',
  usage: 'usage: slopweaver facts <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--home <dir>] [--corpus <dir>]',
  example: 'slopweaver facts "auth flow"',
} as const

const loadFacts = () => import('../commands/facts/run.js').then((m) => m.factsRunCommand)

export const factsManifest: Readonly<Record<string, VerbManifestEntry>> = {
  '': lazy({ meta: factsMeta, load: loadFacts }),
  run: lazy({ meta: factsMeta, load: loadFacts }),
}
