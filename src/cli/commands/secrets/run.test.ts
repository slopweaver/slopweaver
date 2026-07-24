import { describe, expect, it } from "vitest";
import { ok, type Result, unwrap, unwrapErr } from "../../../lib/result.js";
import type { SecretName } from "../../../secrets/names.js";
import type { SecretWriteResult } from "../../../secrets/store.js";
import { parseSecretsSetArgs, runSecretsSetWithDeps, type SecretsDeps, secretSource } from "./run.js";

interface Captured {
  readonly deps: SecretsDeps;
  readonly out: string[];
  readonly errors: string[];
  readonly wrote: { name: SecretName; value: string }[];
  readonly prompted: string[];
}

/**
 * A full SecretsDeps fake (plain functions, no mocks). `piped` is the piped-stdin value; `prompted` is what
 * the no-echo prompt returns; `tty` selects which source the shell uses.
 */
function fakeDeps({
  piped = "",
  prompted = "",
  tty = false,
}: {
  piped?: string;
  prompted?: string;
  tty?: boolean;
}): Captured {
  const out: string[] = [];
  const errors: string[] = [];
  const wrote: { name: SecretName; value: string }[] = [];
  const promptedWith: string[] = [];
  const deps: SecretsDeps = {
    home: () => "/fake/state",
    isTty: () => tty,
    logger: {
      error: (m) => {
        errors.push(m);
      },
      out: (m) => {
        out.push(m);
      },
    },
    promptNoEcho: async ({ prompt }) => {
      promptedWith.push(prompt);
      return prompted;
    },
    readPipedStdin: async () => piped,
    writeSecret: ({ name, value }): Result<SecretWriteResult> => {
      wrote.push({ name, value });
      return ok({ name, path: `/fake/state/secrets/${name}`, written: true });
    },
  };
  return { deps, errors, out, prompted: promptedWith, wrote };
}

const argvSet = (rest: readonly string[]): readonly string[] => ["node", "cli", "secrets", "set", ...rest];

describe("secretSource", () => {
  it("prompts on an interactive TTY", () => {
    expect(secretSource({ forceStdin: false, isTty: true })).toBe("prompt");
  });

  it("reads piped stdin when not a TTY", () => {
    expect(secretSource({ forceStdin: false, isTty: false })).toBe("stdin");
  });

  it("reads piped stdin when --stdin forces it, even on a TTY", () => {
    expect(secretSource({ forceStdin: true, isTty: true })).toBe("stdin");
  });
});

describe("parseSecretsSetArgs", () => {
  it("parses name + flags", () => {
    const parsed = parseSecretsSetArgs({ rest: ["slack-user-token", "--stdin", "--json"] });
    expect(parsed.ok).toBe(true);
    expect(unwrap(parsed)).toEqual({ json: true, name: "slack-user-token", stdin: true });
  });

  it("rejects a missing name", () => {
    const parsed = parseSecretsSetArgs({ rest: ["--stdin"] });
    expect(parsed.ok).toBe(false);
    expect(unwrapErr(parsed)[0]).toBe("missing secret name");
  });

  it("rejects a stray argv value after the name (no token may ride on argv)", () => {
    const parsed = parseSecretsSetArgs({ rest: ["slack-user-token", "stray-argv-value"] });
    expect(parsed.ok).toBe(false);
  });
});

describe("runSecretsSetWithDeps", () => {
  it("captures the value from the no-echo prompt on a TTY and writes it", async () => {
    const cap = fakeDeps({ prompted: "fake-slack-value\n", tty: true });
    const code = await runSecretsSetWithDeps({ argv: argvSet(["slack-user-token"]), deps: cap.deps });
    expect(code).toBe(0);
    expect(cap.wrote).toEqual([{ name: "slack-user-token", value: "fake-slack-value" }]);
    expect(cap.prompted[0]).toContain("slack-user-token");
  });

  it("reads piped stdin when not a TTY", async () => {
    const cap = fakeDeps({ piped: "fake-slack-value\n", tty: false });
    const code = await runSecretsSetWithDeps({ argv: argvSet(["slack-user-token"]), deps: cap.deps });
    expect(code).toBe(0);
    expect(cap.wrote).toEqual([{ name: "slack-user-token", value: "fake-slack-value" }]);
  });

  it("never prints the secret value on stdout or stderr", async () => {
    const cap = fakeDeps({ prompted: "NEVER-PRINT-THIS\n", tty: true });
    await runSecretsSetWithDeps({ argv: argvSet(["slack-user-token"]), deps: cap.deps });
    expect([...cap.out, ...cap.errors].join("\n")).not.toContain("NEVER-PRINT-THIS");
  });

  it("emits a value-free --json shape", async () => {
    const cap = fakeDeps({ piped: "fake-linear-value\n" });
    await runSecretsSetWithDeps({ argv: argvSet(["linear-token", "--stdin", "--json"]), deps: cap.deps });
    expect(JSON.parse(cap.out[0]!)).toEqual({
      name: "linear-token",
      ok: true,
      path: "/fake/state/secrets/linear-token",
    });
  });

  it("errors on an empty captured value (e.g. Ctrl-C at the prompt)", async () => {
    const cap = fakeDeps({ prompted: "", tty: true });
    const code = await runSecretsSetWithDeps({ argv: argvSet(["linear-token"]), deps: cap.deps });
    expect(code).toBe(1);
    expect(cap.wrote).toEqual([]);
  });
});
