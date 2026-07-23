import { describe, expect, it } from "vitest";
import type { IdentitySource } from "../../silver/identity.js";
import { buildMemberIdentity } from "./email.js";
import { aggregateMemberWarnings, isLinkableMember, memberCandidate, memberIdentityCandidates } from "./project.js";
import type { MemberBronzeRow, MemberProfileFields } from "./types.js";

function row({
  source,
  nativeId,
  email,
  profile = {},
  warnings = [],
}: {
  source: IdentitySource;
  nativeId: string;
  email?: string;
  profile?: MemberProfileFields;
  warnings?: readonly string[];
}): MemberBronzeRow {
  return {
    fetchedAtIso: "2026-07-20T00:00:00.000Z",
    identity: buildMemberIdentity({ name: nativeId, nativeId, source, ...(email !== undefined ? { email } : {}) }),
    profile,
    provenance: [],
    raw: {},
    source,
    sourceId: nativeId,
    version: 1,
    warnings,
  };
}

describe("memberCandidate", () => {
  it("carries a trusted email onto the resolver candidate (so the email tier fires)", () => {
    const candidate = memberCandidate({ row: row({ email: "ada@example.com", nativeId: "U1", source: "slack" }) });
    expect(candidate).toEqual({ email: "ada@example.com", name: "U1", nativeId: "U1", source: "slack" });
  });

  it("omits the email when the member has none (capability gap) — it can never email-merge", () => {
    const candidate = memberCandidate({ row: row({ nativeId: "u", source: "notion" }) });
    expect(candidate).toEqual({ name: "u", nativeId: "u", source: "notion" });
  });

  it("omits a weak/held email from the join surface", () => {
    const candidate = memberCandidate({ row: row({ email: "support@example.com", nativeId: "U1", source: "slack" }) });
    expect(candidate.email).toBeUndefined();
  });

  it("DROPS the handle when there is no trusted email — a shared handle must never merge two people", () => {
    const noEmail = memberCandidate({ row: withHandle({ handle: "sam", nativeId: "U1", source: "slack" }) });
    expect(noEmail.handle).toBeUndefined();
    // With a trusted email the handle rides along (display-only — the email tier does the merge).
    const withEmail = memberCandidate({
      row: withHandle({ email: "sam@example.com", handle: "sam", nativeId: "U2", source: "slack" }),
    });
    expect(withEmail.handle).toBe("sam");
  });
});

/** A member row carrying an explicit handle (to exercise the handle-drop rule). */
function withHandle({
  source,
  nativeId,
  handle,
  email,
}: {
  source: IdentitySource;
  nativeId: string;
  handle: string;
  email?: string;
}): MemberBronzeRow {
  return {
    fetchedAtIso: "2026-07-20T00:00:00.000Z",
    identity: buildMemberIdentity({
      handle,
      name: nativeId,
      nativeId,
      source,
      ...(email !== undefined ? { email } : {}),
    }),
    profile: {},
    provenance: [],
    raw: {},
    source,
    sourceId: nativeId,
    version: 1,
    warnings: [],
  };
}

describe("isLinkableMember", () => {
  it("excludes a bot", () => {
    expect(isLinkableMember({ row: row({ nativeId: "b", profile: { bot: true }, source: "notion" }) })).toBe(false);
  });

  it("excludes a deactivated member", () => {
    expect(isLinkableMember({ row: row({ nativeId: "d", profile: { active: false }, source: "slack" }) })).toBe(false);
  });

  it("includes a real active human", () => {
    expect(
      isLinkableMember({ row: row({ nativeId: "a", profile: { active: true, bot: false }, source: "slack" }) }),
    ).toBe(true);
  });
});

describe("memberIdentityCandidates", () => {
  it("emits one email-bearing candidate per linkable member across sources, dropping bots + deactivated", () => {
    const rows = [
      row({ email: "ada@example.com", nativeId: "U1", source: "slack" }),
      row({ email: "ada@example.com", nativeId: "ada", source: "github" }),
      row({ nativeId: "botU", profile: { bot: true }, source: "notion" }),
      row({ email: "ada@example.com", nativeId: "dead", profile: { active: false }, source: "linear" }),
    ];
    const candidates = memberIdentityCandidates({ rows });
    expect(candidates.map((c) => c.source)).toEqual(["slack", "github"]);
    expect(candidates.every((c) => c.email === "ada@example.com")).toBe(true);
  });
});

describe("aggregateMemberWarnings", () => {
  it("dedups + sorts per-member warnings", () => {
    const rows = [
      row({ nativeId: "a", source: "slack", warnings: ["z-warn", "a-warn"] }),
      row({ nativeId: "b", source: "slack", warnings: ["a-warn"] }),
    ];
    expect(aggregateMemberWarnings({ rows })).toEqual(["a-warn", "z-warn"]);
  });
});
