import { describe, expect, it } from "vitest";
import { redactStructureRow } from "./redact.js";
import type { StructureBronzeRow } from "./types.js";

// A long digit run is a secret CLASS `redactSecrets` scrubs (→ `[number]`) but is NOT a hygiene leak shape,
// so the fixture can live in-repo. (A real `ghp_`/`xox` token literal would itself trip the hygiene gate.)
const SECRET_DIGITS = "998877665544332211";

const BASE: StructureBronzeRow = {
  attrs: { description: `runbook id ${SECRET_DIGITS}` },
  fetchedAtIso: "2026-07-20T00:00:00.000Z",
  identity: { name: "platform", nativeId: "acme/platform", slug: "acme/platform" },
  kind: "repo",
  provenance: ["github.orgs.listRepos"],
  raw: { full_name: "acme/platform", webhookId: SECRET_DIGITS },
  relations: [],
  source: "github",
  sourceId: "acme/platform",
  version: 1,
  warnings: [],
};

describe("redactStructureRow", () => {
  it("scrubs a secret in a raw string leaf while keeping the org identifiers", () => {
    const redacted = redactStructureRow({ row: BASE });
    expect(redacted.raw).toEqual({ full_name: "acme/platform", webhookId: "[number]" });
    expect(redacted.identity.name).toBe("platform");
  });

  it("scrubs a secret in a curated free-text attr", () => {
    const redacted = redactStructureRow({ row: BASE });
    expect(redacted.attrs["description"]).toBe("runbook id [number]");
  });
});
