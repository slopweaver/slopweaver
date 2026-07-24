/**
 * Lazy manifest for the `connect` noun — the read-only source preflight. `connect <source>` (the bare
 * default) and `connect check <source>` both resolve to the one handler; the SDK-probe module loads only
 * when dispatched, keeping the connector clients off every unrelated invocation's load path.
 */
import { DEFAULT_VERB, lazy, type VerbManifestEntry } from "../manifest.js";

const connectMeta = {
  createsWorkItem: false,
  diagnostic: true,
  doorRouted: false,
  dryParseSafe: false,
  effect: "external-read",
  example: "slopweaver connect slack --check --json",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  summary: "Preflight a source: reachability + the exact scopes/capabilities its ingest needs (+ a 1-item read)",
  usage:
    "usage: slopweaver connect <github|slack|linear|notion> --check [--json] [--repo owner/repo] [--github-org <org>]",
} as const;

const loadConnect = () => import("../commands/connect/run.js").then((m) => m.connectCheckCommand);

export const connectManifest: Readonly<Record<string, VerbManifestEntry>> = {
  [DEFAULT_VERB]: lazy({ load: loadConnect, meta: connectMeta }),
  check: lazy({ load: loadConnect, meta: connectMeta }),
};
