/**
 * Lazy manifest for the `catalog` noun — the command-surface index. Bare-noun and `list` verb share one
 * loader; the command module loads only when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const catalogMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: "slopweaver catalog --json",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  summary: "List the command surface (human, --json, or --capabilities) from the registry",
  usage: "usage: slopweaver catalog [--json] [--capabilities]",
} as const;

const loadCatalog = () => import("../commands/catalog/run.js").then((m) => m.catalogRunCommand);

export const catalogManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadCatalog, meta: catalogMeta }),
  list: lazy({ load: loadCatalog, meta: catalogMeta }),
};
