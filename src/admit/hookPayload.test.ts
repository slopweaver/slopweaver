import { describe, expect, it } from "vitest";

import { evaluateHookPayload, type HookDecision } from "./hookPayload.js";
import { RAW_ESCAPE } from "./rawTools.js";

/** A Bash PreToolUse payload for `command`. */
function bash({ command }: { command: string }): { tool_name: string; tool_input: { command: string } } {
  return { tool_input: { command }, tool_name: "Bash" };
}

/** Assert a decision is a block and return its message (throws otherwise — keeps assertions unconditional). */
function blockedMessage({ decision }: { decision: HookDecision }): string {
  if (!decision.block) {
    throw new Error("expected a block decision, got allow");
  }
  return decision.message;
}

describe("evaluateHookPayload", () => {
  it("blocks a raw mutating Bash command with the escape message", () => {
    const decision = evaluateHookPayload({ allowRaw: false, payload: bash({ command: "gh pr merge 1" }) });
    expect(decision.block).toBe(true);
    expect(blockedMessage({ decision })).toContain(RAW_ESCAPE);
  });

  it("allows a read-only Bash command", () => {
    expect(evaluateHookPayload({ allowRaw: false, payload: bash({ command: "git status" }) })).toEqual({
      block: false,
    });
  });

  it("allows a would-be-blocked command under the escape", () => {
    expect(evaluateHookPayload({ allowRaw: true, payload: bash({ command: "gh pr merge 1" }) })).toEqual({
      block: false,
    });
  });

  it("allows a well-formed non-Bash tool", () => {
    expect(
      evaluateHookPayload({
        allowRaw: false,
        payload: { tool_input: { content: "y", file_path: "/x" }, tool_name: "Write" },
      }),
    ).toEqual({ block: false });
  });

  it("BLOCKS loudly on a malformed (non-object) payload — fail closed, not fail open", () => {
    const decision = evaluateHookPayload({ allowRaw: false, payload: "not-an-object" });
    expect(decision.block).toBe(true);
    expect(blockedMessage({ decision })).toContain("malformed");
  });

  it("BLOCKS loudly on a Bash payload missing its command", () => {
    const decision = evaluateHookPayload({ allowRaw: false, payload: { tool_input: {}, tool_name: "Bash" } });
    expect(decision.block).toBe(true);
    expect(blockedMessage({ decision })).toContain("missing tool_input.command");
  });
});
