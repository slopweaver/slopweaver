import { describe, expect, it } from "vitest";
import type { ConnectCheckReport } from "../../../connect/types.js";
import { finaliseReport } from "../../../connect/types.js";
import { ok, type Result, unwrap, unwrapErr } from "../../../lib/result.js";
import { type ConnectDeps, parseConnectArgs, runConnectWithDeps } from "./run.js";

interface Captured {
  readonly deps: ConnectDeps;
  readonly out: string[];
  readonly errors: string[];
  readonly calls: string[];
}

const readyReport = (source: ConnectCheckReport["source"]): ConnectCheckReport =>
  finaliseReport({ capabilities: [{ detail: "ok", id: "auth", status: "ok" }], source, tokenPresent: true });

const notReadyReport = (source: ConnectCheckReport["source"]): ConnectCheckReport =>
  finaliseReport({
    capabilities: [{ detail: "gap", id: "scope:read:org", status: "missing" }],
    source,
    tokenPresent: true,
  });

/** A full ConnectDeps fake (plain functions). `slackReport`/`githubReport` seed the dispatched report. */
function fakeDeps({
  slackReport = readyReport("slack"),
  githubReport = readyReport("github"),
  orgResult = ok("acme"),
}: {
  slackReport?: ConnectCheckReport;
  githubReport?: ConnectCheckReport;
  orgResult?: Result<string>;
}): Captured {
  const out: string[] = [];
  const errors: string[] = [];
  const calls: string[] = [];
  const deps: ConnectDeps = {
    connectGithub: async ({ org, token }) => {
      calls.push(`github:${org}:${token ?? "none"}`);
      return githubReport;
    },
    connectLinear: async () => {
      calls.push("linear");
      return readyReport("linear");
    },
    connectNotion: async () => {
      calls.push("notion");
      return readyReport("notion");
    },
    connectSlack: async ({ kind }) => {
      calls.push(`slack:${kind}`);
      return slackReport;
    },
    githubToken: () => "gh-tok",
    linearToken: () => "lin-tok",
    logger: {
      error: (m) => {
        errors.push(m);
      },
      out: (m) => {
        out.push(m);
      },
    },
    notionToken: () => "notion-tok",
    resolveGithubOrg: () => orgResult,
    slackRead: () => ({ kind: "user", token: "xoxp" }),
  };
  return { calls, deps, errors, out };
}

const argv = (rest: readonly string[]): readonly string[] => ["node", "cli", "connect", ...rest];

describe("parseConnectArgs", () => {
  it("parses a source + flags", () => {
    expect(unwrap(parseConnectArgs({ rest: ["slack", "--check", "--json"] }))).toEqual({ json: true, source: "slack" });
  });

  it("rejects a missing source", () => {
    expect(unwrapErr(parseConnectArgs({ rest: ["--check"] }))[0]).toContain("missing source");
  });

  it("rejects an unknown source", () => {
    expect(unwrapErr(parseConnectArgs({ rest: ["jira"] }))[0]).toContain("unknown source: jira");
  });
});

describe("runConnectWithDeps", () => {
  it("dispatches to Slack and emits value-free JSON, exit 0 when ready", async () => {
    const cap = fakeDeps({});
    const code = await runConnectWithDeps({ argv: argv(["slack", "--check", "--json"]), deps: cap.deps });
    expect(code).toBe(0);
    expect(cap.calls).toEqual(["slack:user"]);
    expect(JSON.parse(cap.out[0]!).source).toBe("slack");
  });

  it("exits 3 (a diagnostic finding) when the connection is not ready", async () => {
    const cap = fakeDeps({ slackReport: notReadyReport("slack") });
    const code = await runConnectWithDeps({ argv: argv(["slack", "--check", "--json"]), deps: cap.deps });
    expect(code).toBe(3);
  });

  it("resolves the org then probes GitHub with the resolved token", async () => {
    const cap = fakeDeps({});
    await runConnectWithDeps({ argv: argv(["github", "--check", "--repo", "acme/app"]), deps: cap.deps });
    expect(cap.calls).toEqual(["github:acme:gh-tok"]);
  });

  it("returns a not-ready report (no probe) when the org cannot be resolved", async () => {
    const cap = fakeDeps({ orgResult: { errors: ["no origin remote"], ok: false, warnings: [] } });
    const code = await runConnectWithDeps({ argv: argv(["github", "--check", "--json"]), deps: cap.deps });
    expect(code).toBe(3);
    expect(cap.calls).toEqual([]);
  });

  it("rejects an unknown source I/O-free (no probe dispatched)", async () => {
    const cap = fakeDeps({});
    const code = await runConnectWithDeps({ argv: argv(["jira", "--check"]), deps: cap.deps });
    expect(code).toBe(2);
    expect(cap.calls).toEqual([]);
  });
});
