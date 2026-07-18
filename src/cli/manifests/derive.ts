/**
 * Lazy manifest for the `derive` noun — bare-noun + `run` share one loader, so the module loads only
 * when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const deriveMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver derive",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  summary: "Derive deterministic silver (directory + graph + opportunities) from the corpus",
  usage: "usage: slopweaver derive [--home <dir>] [--corpus <dir>] [--top N] [--dry-run]",
} as const;

const loadDerive = () => import("../commands/derive/run.js").then((m) => m.deriveRunCommand);

export const deriveManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadDerive, meta: deriveMeta }),
  run: lazy({ load: loadDerive, meta: deriveMeta }),
};
