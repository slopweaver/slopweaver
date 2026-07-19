/**
 * Lazy manifest for the `identity` noun — read-only cross-source person resolution. `show` (also the bare
 * default) lists/filters canonical people; `resolve` maps a raw handle/id to its canonical person. Each
 * loads only when dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const showMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: "slopweaver identity show --json",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  summary: "Show every canonical person: their per-source ids + how each was linked",
  usage: "usage: slopweaver identity show [<handle|id>] [--home <dir>] [--corpus <dir>] [--json]",
} as const;

const resolveMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: true,
  effect: "none",
  example: "slopweaver identity resolve @ada",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  summary: "Resolve a raw handle/id to its canonical cross-source person",
  usage: "usage: slopweaver identity resolve <handle|id> [--home <dir>] [--corpus <dir>] [--json]",
} as const;

const loadShow = () => import("../commands/identity/run.js").then((m) => m.identityShowCommand);
const loadResolve = () => import("../commands/identity/run.js").then((m) => m.identityResolveCommand);

export const identityManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadShow, meta: showMeta }),
  resolve: lazy({ load: loadResolve, meta: resolveMeta }),
  show: lazy({ load: loadShow, meta: showMeta }),
};
