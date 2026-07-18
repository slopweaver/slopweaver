/**
 * Lazy manifest for the `init` noun. Bare-noun and `run` verb share one loader, so enumeration stays
 * import-free and the command module loads only when `init` is dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const initMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver init",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  summary: "Scaffold $SLOPWEAVER_HOME (idempotent): corpus/beliefs/ledgers dirs + seed files",
  usage: "usage: slopweaver init [--home <dir>]",
} as const;

const loadInit = () => import("../commands/init/run.js").then((m) => m.initRunCommand);

export const initManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadInit, meta: initMeta }),
  run: lazy({ load: loadInit, meta: initMeta }),
};
