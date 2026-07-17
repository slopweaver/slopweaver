/**
 * Lazy manifest for the `ask` noun — bare-noun + `run` share one loader, so the (embedder-heavy) module
 * loads only when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from '../manifest.js'

const askMeta = {
  summary: 'Ask a grounded question of your local world model',
  usage: 'usage: slopweaver ask <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--home <dir>] [--corpus <dir>]',
  example: 'slopweaver ask "what changed in the refresh pipeline?"',
} as const

const loadAsk = () => import('../commands/ask/run.js').then((m) => m.askRunCommand)

export const askManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ meta: askMeta, load: loadAsk }),
  run: lazy({ meta: askMeta, load: loadAsk }),
}
