import { describe, expect, it } from "vitest";

import type { CorpusRecord } from "../corpus/types.js";
import { type AskScope, askerIsOwner, planOwnerScopedRetrieval, scopeRecordsForAsker } from "./accessScope.js";
import type { OwnerIdentity } from "./ownerScope.js";

const publicRecord: CorpusRecord = {
  container: "slack/C_PUBLIC",
  kind: "message",
  refs: [],
  source: "slack",
  sourceId: "C_PUBLIC:1",
  text: "team ship note",
  tsIso: "2026-01-02T00:00:00.000Z",
  url: "https://example.com/r/pub",
};
const privateRecord: CorpusRecord = {
  container: "slack/D_DM",
  kind: "message",
  refs: [],
  source: "slack",
  sourceId: "D_DM:1",
  text: "dm to owner",
  tsIso: "2026-01-02T00:00:00.000Z",
  url: "https://example.com/r/dm",
  visibility: "private",
};
const legacyUnmarked: CorpusRecord = { ...publicRecord, sourceId: "C_PUBLIC:legacy" };
const all = [publicRecord, privateRecord, legacyUnmarked];

const owner: OwnerIdentity = { handles: ["ada", "U_OWNER"], personId: "owner-1" };

describe("askerIsOwner", () => {
  it("treats the trusted local CLI as the owner", () => {
    expect(askerIsOwner({ scope: { trustedOwnerCli: true } })).toBe(true);
  });

  it("treats a known asker equal to the known owner as the owner", () => {
    expect(askerIsOwner({ scope: { askerPersonId: "a", ownerPersonId: "a", trustedOwnerCli: false } })).toBe(true);
  });

  it("treats an unknown remote asker as a non-owner (fail-closed)", () => {
    expect(askerIsOwner({ scope: { ownerPersonId: "a", trustedOwnerCli: false } })).toBe(false);
  });

  it("treats a different asker as a non-owner", () => {
    expect(askerIsOwner({ scope: { askerPersonId: "b", ownerPersonId: "a", trustedOwnerCli: false } })).toBe(false);
  });
});

describe("scopeRecordsForAsker", () => {
  it("returns every record to the owner (including private)", () => {
    const scoped = scopeRecordsForAsker({ records: all, scope: { trustedOwnerCli: true } });
    expect(scoped).toEqual(all);
  });

  it("withholds every private record from a non-owner", () => {
    const scope: AskScope = { askerPersonId: "guest", ownerPersonId: "owner-1", trustedOwnerCli: false };
    const scoped = scopeRecordsForAsker({ records: all, scope });
    expect(scoped).toEqual([publicRecord, legacyUnmarked]);
  });

  it("lets an unmarked legacy record through to a non-owner (reads as public)", () => {
    const scope: AskScope = { askerPersonId: "guest", ownerPersonId: "owner-1", trustedOwnerCli: false };
    const scoped = scopeRecordsForAsker({ records: [legacyUnmarked], scope });
    expect(scoped).toEqual([legacyUnmarked]);
  });
});

describe("planOwnerScopedRetrieval", () => {
  it("engages the owner lens for a first-person ask: all lanes + handle-injected query", () => {
    const planned = planOwnerScopedRetrieval({
      decay: undefined,
      owner,
      question: "what are my open PRs",
      records: all,
    });
    expect(planned.records).toEqual(all);
    expect(planned.query).toBe("what are my open PRs ada U_OWNER");
  });

  it("gives the OWNER every lane on an ordinary org ask too (private not hidden from yourself)", () => {
    const planned = planOwnerScopedRetrieval({
      decay: undefined,
      owner,
      question: "what did the team ship",
      records: all,
    });
    // The DECISION flip: the owner's org ask searches the private lane as well; only the query is verbatim.
    expect(planned.records).toEqual(all);
    expect(planned.query).toBe("what did the team ship");
  });
});
