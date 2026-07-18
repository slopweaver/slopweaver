import { describe, expect, it } from "vitest";

import { runPreToolUseAdmit } from "./pretooluseAdmit.js";

/** Run the hook with an injected stdin string + capture the written diagnostics. */
async function run({
  stdin,
  allowRaw = false,
}: {
  stdin: string;
  allowRaw?: boolean;
}): Promise<{ code: number; errors: readonly string[] }> {
  const errors: string[] = [];
  const code = await runPreToolUseAdmit({
    env: allowRaw ? { SLOPWEAVER_ALLOW_RAW: "1" } : {},
    readStdin: () => Promise.resolve(stdin),
    writeError: (line) => {
      errors.push(line);
    },
  });
  return { code, errors };
}

describe("runPreToolUseAdmit", () => {
  it("blocks a raw mutating Bash command with exit 2 + a message", async () => {
    const { code, errors } = await run({
      stdin: JSON.stringify({ tool_input: { command: "gh pr merge 1" }, tool_name: "Bash" }),
    });
    expect(code).toBe(2);
    expect(errors.join("")).toContain("SLOPWEAVER_ALLOW_RAW=1");
  });

  it("allows a read-only Bash command with exit 0 and no diagnostics", async () => {
    expect(await run({ stdin: JSON.stringify({ tool_input: { command: "git status" }, tool_name: "Bash" }) })).toEqual({
      code: 0,
      errors: [],
    });
  });

  it("allows under the SLOPWEAVER_ALLOW_RAW escape", async () => {
    const { code } = await run({
      allowRaw: true,
      stdin: JSON.stringify({ tool_input: { command: "gh pr merge 1" }, tool_name: "Bash" }),
    });
    expect(code).toBe(0);
  });

  it("FAILS CLOSED (exit 2) on malformed JSON, loudly", async () => {
    const { code, errors } = await run({ stdin: "not-json" });
    expect(code).toBe(2);
    expect(errors.join("")).toContain("malformed");
  });

  it("lets a thrown evaluator reject (so the entry fails closed), never swallowing it", async () => {
    await expect(
      runPreToolUseAdmit({
        env: {},
        evaluate: () => {
          throw new Error("boom");
        },
        readStdin: () => Promise.resolve('{"tool_name":"Bash","tool_input":{"command":"git status"}}'),
        writeError: () => {},
      }),
    ).rejects.toThrow("boom");
  });
});
