import { describe, expect, it } from "vitest";
import {
  buildMemberIdentity,
  classifyEmailTrust,
  finaliseMemberTrust,
  normaliseMemberEmail,
  sharedEmails,
  trustedJoinEmail,
  weakEmailReason,
} from "./email.js";
import type { MemberBronzeRow } from "./types.js";

/** A minimal member row for a source/id/email — the trust starts from the pattern-only preliminary build. */
function row({
  source,
  nativeId,
  email,
}: {
  source: MemberBronzeRow["source"];
  nativeId: string;
  email?: string;
}): MemberBronzeRow {
  return {
    fetchedAtIso: "2026-07-20T00:00:00.000Z",
    identity: buildMemberIdentity({ nativeId, source, ...(email !== undefined ? { email } : {}) }),
    profile: {},
    provenance: [],
    raw: {},
    source,
    sourceId: nativeId,
    version: 1,
    warnings: [],
  };
}

describe("normaliseMemberEmail", () => {
  it("lower-cases and trims", () => {
    expect(normaliseMemberEmail({ email: "  Ada@Example.COM " })).toBe("ada@example.com");
  });
});

describe("weakEmailReason", () => {
  it("flags GitHub noreply addresses", () => {
    expect(weakEmailReason({ email: "12345+ada@users.noreply.github.com" })).toBe("noreply");
  });

  it("flags a noreply local part on any domain (as a shared alias)", () => {
    expect(weakEmailReason({ email: "noreply@example.com" })).toBe("shared-alias:noreply");
  });

  it("flags a role/shared mailbox by exact local part", () => {
    expect(weakEmailReason({ email: "support@example.org" })).toBe("shared-alias:support");
  });

  it("passes a real personal address", () => {
    expect(weakEmailReason({ email: "ada@example.com" })).toBeUndefined();
  });

  it("does NOT flag a personal address that merely contains a role word", () => {
    expect(weakEmailReason({ email: "ada.support.lovelace@example.com" })).toBeUndefined();
  });
});

describe("sharedEmails", () => {
  it("returns exactly the address used by more than one member of the source", () => {
    const rows = [
      row({ email: "shared@example.com", nativeId: "U1", source: "slack" }),
      row({ email: "shared@example.com", nativeId: "U2", source: "slack" }),
      row({ email: "ada@example.com", nativeId: "U3", source: "slack" }),
    ];
    expect([...sharedEmails({ rows })]).toEqual(["shared@example.com"]);
  });
});

describe("classifyEmailTrust", () => {
  it("is missing for no email", () => {
    expect(classifyEmailTrust({ email: undefined, shared: new Set() }).trust).toBe("missing");
  });

  it("is weak with a reason for a role alias", () => {
    expect(classifyEmailTrust({ email: "admin@example.com", shared: new Set() })).toEqual({
      reason: "shared-alias:admin",
      trust: "weak",
    });
  });

  it("is weak for a shared mailbox seen on many members", () => {
    expect(classifyEmailTrust({ email: "dup@example.com", shared: new Set(["dup@example.com"]) })).toEqual({
      reason: "shared-mailbox",
      trust: "weak",
    });
  });

  it("is trusted for a real unique personal address", () => {
    expect(classifyEmailTrust({ email: "ada@example.com", shared: new Set() }).trust).toBe("trusted");
  });
});

describe("buildMemberIdentity", () => {
  it("captures the normalised email + a preliminary trusted classification", () => {
    const identity = buildMemberIdentity({ email: "Ada@Example.com", nativeId: "U1", source: "slack" });
    expect(identity.emailNormalised).toBe("ada@example.com");
    expect(identity.emailTrust).toBe("trusted");
  });

  it("marks a missing email", () => {
    expect(buildMemberIdentity({ nativeId: "U1", source: "slack" }).emailTrust).toBe("missing");
  });
});

describe("finaliseMemberTrust", () => {
  it("downgrades a shared address to weak with a held warning across the source", () => {
    const rows = [
      row({ email: "shared@example.com", nativeId: "U1", source: "slack" }),
      row({ email: "shared@example.com", nativeId: "U2", source: "slack" }),
    ];
    const finalised = finaliseMemberTrust({ rows });
    expect(finalised[0]!.identity.emailTrust).toBe("weak");
    expect(finalised[0]!.warnings).toEqual(["email held (shared-mailbox) — not used to auto-link"]);
    expect(trustedJoinEmail({ row: finalised[0]! })).toBeUndefined();
  });

  it("leaves a unique personal address trusted (its join email survives)", () => {
    const finalised = finaliseMemberTrust({
      rows: [row({ email: "ada@example.com", nativeId: "U1", source: "slack" })],
    });
    expect(finalised[0]!.identity.emailTrust).toBe("trusted");
    expect(trustedJoinEmail({ row: finalised[0]! })).toBe("ada@example.com");
  });
});
