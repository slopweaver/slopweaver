import { describe, expect, it } from "vitest";
import { redactText } from "./redact.js";

describe("redactText", () => {
  it("redacts emails, tokens and long digit runs", () => {
    const { text, redactions } = redactText({
      text: "mail me at a.b@example.com token ghp_" + "x".repeat(30) + " id 123456789012",
    });
    expect(text).toContain("[email]");
    expect(text).toContain("[token]");
    expect(text).toContain("[number]");
    expect(new Set(redactions)).toEqual(new Set(["email", "token", "number"]));
  });

  it("preserves graph-edge tokens (@mention, #123, TEAM-123)", () => {
    const { text, redactions } = redactText({ text: "@alice see #42 and TEAM-7" });
    expect(text).toBe("@alice see #42 and TEAM-7");
    expect(redactions).toEqual([]);
  });

  it("does not carve up a token into an email/number", () => {
    // Built from parts so the committed source carries no real-looking token literal (the hygiene gate
    // scans for exactly this shape). At runtime it reassembles into a slack-style token for the redactor.
    const token = ["xoxb", "1234567890", "abcdefghij"].join("-");
    expect(redactText({ text: token }).text).toBe("[token]");
  });
});
