/**
 * Lazy manifest for the `distil` noun — bare-noun + `run` share one loader, so the (LLM-heavy) module
 * loads only when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const distilMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver distil --dry-run",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  summary: "Distil the corpus into gold (LLM map-reduce; caches per batch)",
  usage:
    "usage: slopweaver distil [--home <dir>] [--corpus <dir>] [--max-per-batch N] [--top-containers N] [--recent-only] [--dry-run]",
} as const;

const loadDistil = () => import("../commands/distil/run.js").then((m) => m.distilRunCommand);

export const distilManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadDistil, meta: distilMeta }),
  run: lazy({ load: loadDistil, meta: distilMeta }),
};
