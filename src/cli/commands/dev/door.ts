/**
 * `slopweaver dev door` — a window onto the admit pathway (no real action exists yet). `--simulate
 * warn|pass|hold` runs a stub request through the door with a built-in stub gate so you can SEE the
 * warn-first + override + hold behaviour end-to-end (and it records to the door ledger); `--raw "<cmd>"`
 * runs a command through the raw-tool classifier so you can see the default-deny + escape. This is how the
 * PR2 proof exercises the door before any capability is wired.
 */

import { admitDoor } from "../../../admit/door.js";
import { recordDoorDecision } from "../../../admit/ledger.js";
import { classifyRawCommand } from "../../../admit/rawTools.js";
import type { DoorGate, DoorRequest } from "../../../admit/types.js";
import { logger } from "../../../lib/logger.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseFlags } from "../../parseFlags.js";

const USAGE = 'usage: slopweaver dev door (--simulate warn|pass|hold | --raw "<command>") [--home <dir>]';

/** The built-in demo gate: emits a warn/hold finding driven by the simulated request, else passes. */
const stubGate: DoorGate = (request) => {
  const mode = request.artifact["simulate"];
  if (mode === "warn") {
    return [
      {
        code: "stub.warn",
        correction: "this is a demonstration warning; re-issue with the override token to let it through",
        override: "stub.warn:v1",
        severity: "warn",
        summary: "stub gate flagged this action (demo warning)",
      },
    ];
  }
  if (mode === "hold") {
    return [
      {
        code: "stub.hold",
        correction: "a hold is the invariant core — not waivable by the per-action override token",
        severity: "hold",
        summary: "stub gate held this action as irreversible harm (demo hold)",
      },
    ];
  }
  return [];
};

/** Print + record a simulated door decision. */
function simulate({ mode, home }: { mode: string; home: string | undefined }): number {
  const request: DoorRequest = {
    action: { kind: "verb", noun: "stub", verb: "demo" },
    artifact: { simulate: mode },
    meta: { createsWorkItem: false, effect: "external-write", home: home ?? null, requiresApproval: true },
  };
  const decision = admitDoor({ env: process.env, gates: [stubGate], request });
  recordDoorDecision({
    decision,
    request,
    runId: `door-demo-${mode}`,
    tsIso: new Date().toISOString(),
    ...(home !== undefined ? { home } : {}),
  });

  logger.out(`door decision: ${decision.status.toUpperCase()}`);
  for (const finding of decision.findings) {
    logger.out(`  [${finding.severity}] ${finding.code}: ${finding.summary}`);
    logger.out(`    → ${finding.correction}`);
    if (finding.severity === "warn") {
      logger.out(`    override: set SLOPWEAVER_DOOR_OVERRIDE=${finding.override} to let this through`);
    }
  }
  for (const finding of decision.overridden) {
    logger.out(`  [overridden] ${finding.code} — waived by SLOPWEAVER_DOOR_OVERRIDE (recorded)`);
  }
  return EXIT_OK;
}

/** Print a raw-command classification (block/allow + the escape message). */
function raw({ command }: { command: string }): number {
  const verdict = classifyRawCommand({ allowRaw: process.env["SLOPWEAVER_ALLOW_RAW"] === "1", command });
  if (verdict.blocked) {
    logger.out(`raw command: BLOCKED — ${verdict.message}`);
    return EXIT_ERROR;
  }
  logger.out(
    `raw command: ALLOWED${verdict.tool !== undefined ? ` (${verdict.tool} via ${process.env["SLOPWEAVER_ALLOW_RAW"] === "1" ? "SLOPWEAVER_ALLOW_RAW escape" : "read-only/unrecognised"})` : ""}`,
  );
  return EXIT_OK;
}

/**
 * Run the door demo verb.
 *
 * @param argv the full process argv
 * @returns the exit code
 */
export function runDoor(argv: readonly string[]): number {
  const rest = argv.slice(3);
  if (rest.includes("--help") || rest.includes("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  const parsed = parseFlags({ allowPositionals: true, args: rest, spec: { string: ["simulate", "raw", "home"] } });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      logger.error(`door: ${e}`);
    });
    logger.error(USAGE);
    return EXIT_USAGE;
  }
  const { values } = parsed.value;
  const home = typeof values["home"] === "string" ? values["home"] : undefined;
  const simulateMode = values["simulate"];
  const rawCommand = values["raw"];

  if (typeof simulateMode === "string") {
    if (!["warn", "pass", "hold"].includes(simulateMode)) {
      logger.error(`door: --simulate must be warn|pass|hold, got ${simulateMode}`);
      logger.error(USAGE);
      return EXIT_USAGE;
    }
    return simulate({ home, mode: simulateMode });
  }
  if (typeof rawCommand === "string") {
    return raw({ command: rawCommand });
  }
  logger.error('door: pass --simulate warn|pass|hold or --raw "<command>"');
  logger.error(USAGE);
  return EXIT_USAGE;
}

export const doorCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver dev door --simulate warn",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  run: runDoor,
  summary: 'Exercise the admit door: --simulate warn|pass|hold, or --raw "<cmd>" to test the raw-tool block',
  usage: USAGE,
});
