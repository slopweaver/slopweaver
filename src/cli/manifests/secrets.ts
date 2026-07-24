/**
 * Lazy manifest for the `secrets` noun — transcript-safe connector-token capture. Only `set` exists (a
 * bare `slopweaver secrets` falls through to usage). The command module loads only when dispatched, so the
 * stdin/fs edge stays off every unrelated invocation's load path.
 */
import { lazy, type VerbManifestEntry } from "../manifest.js";

const secretsSetMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver secrets set slack-user-token",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  summary:
    "Persist a connector token to $SLOPWEAVER_HOME/secrets/<name> (0600) — no-echo prompt or piped stdin, never argv",
  usage: "usage: slopweaver secrets set <name> [--stdin] [--home <dir>] [--json]",
} as const;

const loadSet = () => import("../commands/secrets/run.js").then((m) => m.secretsSetCommand);

export const secretsManifest: Readonly<Record<string, VerbManifestEntry>> = {
  set: lazy({ load: loadSet, meta: secretsSetMeta }),
};
