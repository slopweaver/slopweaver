/**
 * Lazy manifest for the `ask` noun — bare-noun + `run` share one loader, so the (embedder-heavy) module
 * loads only when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const askMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: 'slopweaver ask "what changed in the refresh pipeline?"',
  parseRejectIsIoFree: false,
  requiresApproval: false,
  summary: "Ask a grounded question of your local world model",
  usage:
    "usage: slopweaver ask <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--json] [--home <dir>] [--corpus <dir>]",
} as const;

const loadAsk = () => import("../commands/ask/run.js").then((m) => m.askRunCommand);

export const askManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadAsk, meta: askMeta }),
  run: lazy({ load: loadAsk, meta: askMeta }),
};
