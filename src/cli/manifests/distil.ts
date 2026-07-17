/**
 * Lazy manifest for the `distil` noun — bare-noun + `run` share one loader, so the (LLM-heavy) module
 * loads only when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from '../manifest.js'

const distilMeta = {
  summary: 'Distil the corpus into gold (LLM map-reduce; caches per batch)',
  usage: 'usage: slopweaver distil [--home <dir>] [--corpus <dir>] [--max-per-batch N] [--top-containers N] [--recent-only] [--dry-run]',
  effect: 'local-state',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  example: 'slopweaver distil --dry-run',
  parseRejectIsIoFree: false,
  diagnostic: false,
} as const

const loadDistil = () => import('../commands/distil/run.js').then((m) => m.distilRunCommand)

export const distilManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ meta: distilMeta, load: loadDistil }),
  run: lazy({ meta: distilMeta, load: loadDistil }),
}
