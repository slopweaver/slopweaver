/**
 * Lazy manifest for the `dev` noun — repo-development verbs. `gate` is the composed PR gate;
 * `door-coverage` proves no side-effect seam bypasses the door; `door` demonstrates the admit pathway.
 * Each loads only when dispatched.
 */
import { lazy, type VerbManifestEntry } from "../manifest.js";

const gateMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver dev gate --pr-body-file pr.md",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  summary: "Run the PR gate: hygiene + PR-format + eval-regression (single non-zero exit + a ledger)",
  usage: "usage: slopweaver dev gate [--home <dir>] [--pr-body-file <path>]",
} as const;

const doorCoverageMeta = {
  createsWorkItem: false,
  diagnostic: true,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: "slopweaver dev door-coverage --json",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  summary: "Prove every side-effect seam is routed through the door (or an acknowledged local-state seam)",
  usage: "usage: slopweaver dev door-coverage [--json]",
} as const;

const lintMeta = {
  createsWorkItem: false,
  diagnostic: true,
  doorRouted: false,
  dryParseSafe: false,
  effect: "none",
  example: "slopweaver dev lint",
  parseRejectIsIoFree: true,
  requiresApproval: false,
  summary:
    "Run every static-analysis check (biome + prettier + oxlint + eslint + knip + constraints + hygiene + door-coverage)",
  usage: "usage: slopweaver dev lint",
} as const;

const doorMeta = {
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver dev door --simulate warn",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  summary: 'Exercise the admit door: --simulate warn|pass|hold, or --raw "<cmd>" to test the raw-tool block',
  usage: 'usage: slopweaver dev door (--simulate warn|pass|hold | --raw "<command>") [--home <dir>]',
} as const;

const loadGate = () => import("../commands/dev/run.js").then((m) => m.devGateCommand);
const loadDoorCoverage = () => import("../commands/dev/doorCoverage.js").then((m) => m.doorCoverageCommand);
const loadDoor = () => import("../commands/dev/door.js").then((m) => m.doorCommand);
const loadLint = () => import("../commands/dev/lint.js").then((m) => m.devLintCommand);

export const devManifest: Readonly<Record<string, VerbManifestEntry>> = {
  door: lazy({ load: loadDoor, meta: doorMeta }),
  "door-coverage": lazy({ load: loadDoorCoverage, meta: doorCoverageMeta }),
  gate: lazy({ load: loadGate, meta: gateMeta }),
  lint: lazy({ load: loadLint, meta: lintMeta }),
};
