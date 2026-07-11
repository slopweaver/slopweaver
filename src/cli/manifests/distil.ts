/**
 * Lazy manifest for the `distil` noun — bare-noun + `run` share one loader, so the (LLM-heavy) module
 * loads only when dispatched.
 */
import { lazy, type VerbManifestEntry } from '../manifest.js'

const distilMeta = {
  summary: 'Distil the corpus into gold (LLM map-reduce; caches per batch)',
  usage: 'usage: slopweaver distil [--home <dir>] [--corpus <dir>] [--max-per-batch N] [--top-containers N] [--recent-only] [--dry-run]',
  example: 'slopweaver distil --dry-run',
} as const

const loadDistil = () => import('../commands/distil/run.js').then((m) => m.distilRunCommand)

export const distilManifest: Readonly<Record<string, VerbManifestEntry>> = {
  '': lazy({ meta: distilMeta, load: loadDistil }),
  run: lazy({ meta: distilMeta, load: loadDistil }),
}
