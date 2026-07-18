import { describe, expect, it } from "vitest";

import { doorLedgerLine } from "./ledger.js";
import type { DoorDecision, DoorRequest } from "./types.js";

const request: DoorRequest = {
  action: { kind: "verb", noun: "demo", verb: "run" },
  artifact: {},
  meta: { createsWorkItem: false, effect: "external-write", home: null, requiresApproval: true },
};

describe("doorLedgerLine", () => {
  it("records a warn decision as one exact JSON object", () => {
    const decision: DoorDecision = {
      findings: [{ code: "demo.warn", correction: "c", override: "demo.run:v1", severity: "warn", summary: "s" }],
      overridden: [],
      status: "warn",
    };
    expect(JSON.parse(doorLedgerLine({ decision, request, runId: "r1", tsIso: "2026-07-14T00:00:00.000Z" }))).toEqual({
      action: "verb:demo.run",
      effect: "external-write",
      findings: [{ code: "demo.warn", severity: "warn" }],
      overridden: [],
      runId: "r1",
      schemaVersion: 1,
      status: "warn",
      tsIso: "2026-07-14T00:00:00.000Z",
    });
  });

  it("records an overridden pass with the waived finding codes", () => {
    const decision: DoorDecision = {
      findings: [],
      overridden: [{ code: "demo.warn", correction: "c", override: "demo.run:v1", severity: "warn", summary: "s" }],
      status: "pass",
    };
    expect(JSON.parse(doorLedgerLine({ decision, request, runId: "r2", tsIso: "t" })).overridden).toEqual([
      "demo.warn",
    ]);
  });

  it("records a raw-tool action label", () => {
    const rawRequest: DoorRequest = {
      action: { command: "gh pr merge 1", kind: "raw-tool", tool: "gh" },
      artifact: {},
      meta: { createsWorkItem: false, effect: "external-write", home: null, requiresApproval: true },
    };
    const decision: DoorDecision = { findings: [], overridden: [], status: "hold" };
    expect(JSON.parse(doorLedgerLine({ decision, request: rawRequest, runId: "r3", tsIso: "t" })).action).toBe(
      "raw-tool:gh",
    );
  });
});
