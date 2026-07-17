/**
 * The door's audit trail. EVERY decision — pass, warn, hold, and any override that waived a warning — is
 * appended to `$SLOPWEAVER_HOME/ledgers/door.jsonl` (D15 provenance), so "no silent send, no silent
 * refuse" is not just a claim but a record. Pure `doorLedgerLine` builds the exact JSON; `recordDoorDecision`
 * is the thin effectful append (allowlisted in the coverage scan as a sanctioned writer).
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { stateHomePaths } from "../stateHome.js";
import type { DoorDecision, DoorRequest } from "./types.js";

/** The action, flattened to a stable, machine-safe label for the ledger. */
function actionLabel({ request }: { request: DoorRequest }): string {
  const { action } = request;
  return action.kind === "verb" ? `verb:${action.noun}.${action.verb}` : `raw-tool:${action.tool}`;
}

/**
 * Build the one JSONL line for a door decision. Pure + deterministic (runId/tsIso injected). Records the
 * status, the finding codes, and any overridden codes — enough to audit, without dumping artifact contents.
 *
 * @param request the admitted request
 * @param decision the door's verdict
 * @param runId the run id
 * @param tsIso the decision timestamp
 * @returns the JSON line (no trailing newline)
 */
export function doorLedgerLine({
  request,
  decision,
  runId,
  tsIso,
}: {
  request: DoorRequest;
  decision: DoorDecision;
  runId: string;
  tsIso: string;
}): string {
  return JSON.stringify({
    action: actionLabel({ request }),
    effect: request.meta.effect,
    findings: decision.findings.map((f) => ({ code: f.code, severity: f.severity })),
    overridden: decision.overridden.map((f) => f.code),
    runId,
    schemaVersion: 1,
    status: decision.status,
    tsIso,
  });
}

/**
 * Append a door decision to the door ledger, creating the ledgers dir if needed. Effectful edge.
 *
 * @param request the admitted request
 * @param decision the door's verdict
 * @param runId the run id
 * @param tsIso the decision timestamp
 * @param home the state home (defaults to the resolved home)
 */
export function recordDoorDecision({
  request,
  decision,
  runId,
  tsIso,
  home,
}: {
  request: DoorRequest;
  decision: DoorDecision;
  runId: string;
  tsIso: string;
  home?: string;
}): void {
  const ledgers = stateHomePaths(home !== undefined ? { home } : {}).ledgers;
  mkdirSync(ledgers, { recursive: true });
  appendFileSync(join(ledgers, "door.jsonl"), `${doorLedgerLine({ decision, request, runId, tsIso })}\n`, "utf8");
}
