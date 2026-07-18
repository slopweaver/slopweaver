/**
 * `slopweaver dev gate` — run the composed PR gate (hygiene + PR-format + eval-regression) with a single
 * non-zero exit and a ledger of what happened. Thin CLI edge over `runDevGate`; the logic + tests live in
 * `src/devGate/`.
 */

import { runDevGate } from "../../../devGate/devGate.js";
import { logger } from "../../../lib/logger.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_OK } from "../../exitCodes.js";

const USAGE = "usage: slopweaver dev gate [--home <dir>] [--pr-body-file <path>]";

/**
 * Run the dev-gate verb.
 *
 * @param argv the full process argv
 * @returns the process exit code (0 all-clear, 1 any check failed)
 */
export function runDevCommand(argv: readonly string[]): number {
  const rest = new Set(argv.slice(3));
  if (rest.has("--help") || rest.has("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  return runDevGate(argv);
}

export const devGateCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver dev gate --pr-body-file pr.md",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  run: runDevCommand,
  summary: "Run the PR gate: hygiene + PR-format + eval-regression (single non-zero exit + a ledger)",
  usage: USAGE,
});
