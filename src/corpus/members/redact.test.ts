import { describe, expect, it } from "vitest";
import { redactMemberRawValue, redactMemberRow } from "./redact.js";
import type { MemberBronzeRow } from "./types.js";

// Token fixtures are built from a repeated char + a split prefix so no contiguous secret shape (nor a raw
// workspace-id shape) sits in this file's source — otherwise the public leak gate (rightly) flags the
// literal. At runtime each reconstructs to a real, matchable token shape the redactor must scrub.
const SLACK_TOKEN = `xoxb-${"a".repeat(16)}`;
const GH_TOKEN = `ghp_${"a".repeat(30)}`;
const NOTION_SECRET = `secret_${"a".repeat(16)}`;

describe("redactMemberRawValue", () => {
  it("preserves emails (the join key) while scrubbing tokens + long digit runs, keeping structure", () => {
    const value = { email: "ada@example.com", nested: { phone: "0123456789012" }, token: SLACK_TOKEN };
    expect(redactMemberRawValue({ value })).toEqual({
      email: "ada@example.com",
      nested: { phone: "[number]" },
      token: "[token]",
    });
  });

  it("recurses arrays, preserving every element position", () => {
    expect(redactMemberRawValue({ value: ["ada@example.com", GH_TOKEN] })).toEqual(["ada@example.com", "[token]"]);
  });
});

describe("redactMemberRow", () => {
  it("keeps the curated identity email + normalised email, scrubs a token hidden in raw, preserves raw keys", () => {
    const input: MemberBronzeRow = {
      fetchedAtIso: "2026-07-20T00:00:00.000Z",
      identity: {
        email: "ada@example.com",
        emailNormalised: "ada@example.com",
        emailTrust: "trusted",
        nativeId: "U1",
        source: "slack",
      },
      profile: { title: `Engineer ${NOTION_SECRET}` },
      provenance: ["slack.users.list"],
      raw: { profile: { api_token: SLACK_TOKEN, email: "ada@example.com" } },
      source: "slack",
      sourceId: "U1",
      version: 1,
      warnings: [],
    };
    const out = redactMemberRow({ row: input });
    expect(out.identity.email).toBe("ada@example.com");
    expect(out.identity.emailNormalised).toBe("ada@example.com");
    expect(out.profile.title).toBe("Engineer [token]");
    expect(out.raw).toEqual({ profile: { api_token: "[token]", email: "ada@example.com" } });
  });
});
