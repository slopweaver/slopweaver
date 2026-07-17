/**
 * Lazy manifest for the `refresh` noun. Like `doctor`, the bare-noun and the `run` verb resolve to the
 * same handler through one lazy loader, so enumeration stays import-free and the (octokit-heavy) command
 * module loads only when `refresh` is actually dispatched.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const refreshMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver refresh --repo octocat/Hello-World",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  summary: "Ingest recent GitHub activity into the local bronze corpus",
  usage:
    "usage: slopweaver refresh [--repo owner/repo] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--lookback-days N] [--no-enrich]",
} as const;

const loadRefresh = () => import("../commands/refresh/run.js").then((m) => m.refreshRunCommand);

export const refreshManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadRefresh, meta: refreshMeta }),
  run: lazy({ load: loadRefresh, meta: refreshMeta }),
};
