/**
 * Lazy manifest for the `facts` noun — bare-noun + `run` share one loader.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const factsMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: 'slopweaver facts "auth flow"',
  parseRejectIsIoFree: false,
  requiresApproval: false,
  summary: "Retrieve the ranked record slice for a question (no LLM)",
  usage:
    "usage: slopweaver facts <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--home <dir>] [--corpus <dir>]",
} as const;

const loadFacts = () => import("../commands/facts/run.js").then((m) => m.factsRunCommand);

export const factsManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadFacts, meta: factsMeta }),
  run: lazy({ load: loadFacts, meta: factsMeta }),
};
