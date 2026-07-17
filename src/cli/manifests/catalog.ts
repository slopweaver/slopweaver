/**
 * Lazy manifest for the `catalog` noun — the command-surface index. Bare-noun and `list` verb share one
 * loader; the command module loads only when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from '../manifest.js'

const catalogMeta = {
  summary: 'List the command surface (human, --json, or --capabilities) from the registry',
  usage: 'usage: slopweaver catalog [--json] [--capabilities]',
  effect: 'none',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  example: 'slopweaver catalog --json',
  parseRejectIsIoFree: true,
  diagnostic: false,
} as const

const loadCatalog = () => import('../commands/catalog/run.js').then((m) => m.catalogRunCommand)

export const catalogManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ meta: catalogMeta, load: loadCatalog }),
  list: lazy({ meta: catalogMeta, load: loadCatalog }),
}
