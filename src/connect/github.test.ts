import { describe, expect, it } from "vitest";
import { typedOk } from "../lib/result.js";
import { checkGithubConnection, classifyGithub, type GithubConnectProbes, type GithubProbe } from "./github.js";
import type { ConnectCapability } from "./types.js";

function cap(caps: readonly ConnectCapability[], id: string): ConnectCapability {
  return caps.find((c) => c.id === id)!;
}

describe("classifyGithub", () => {
  const base: GithubProbe = {
    authReachable: true,
    reposSampled: 5,
    samlPresent: true,
    teamsReadable: true,
    tokenPresent: true,
  };

  it("an org-admin token with SAML + visible repos is ready", () => {
    const report = classifyGithub({ probe: base });
    expect(report.ok).toBe(true);
    expect(cap(report.capabilities, "scope:read:org").status).toBe("ok");
    expect(cap(report.capabilities, "capability:saml-email").status).toBe("ok");
  });

  it("reports the read:org gap (missing) and the SAML gap (warning) when both are blocked", () => {
    const report = classifyGithub({ probe: { ...base, samlPresent: false, teamsReadable: false } });
    expect(report.ok).toBe(false);
    expect(cap(report.capabilities, "scope:read:org").status).toBe("missing");
    expect(cap(report.capabilities, "capability:saml-email").status).toBe("warning");
  });

  it("reports no-repos-visible distinct from bad auth", () => {
    const report = classifyGithub({ probe: { ...base, reposSampled: 0 } });
    expect(report.ok).toBe(false);
    expect(cap(report.capabilities, "read-probe").status).toBe("missing");
    expect(cap(report.capabilities, "auth").status).toBe("ok");
  });

  it("short-circuits when the org is unreachable", () => {
    const report = classifyGithub({ probe: { ...base, authReachable: false } });
    expect(report.ok).toBe(false);
    expect(report.capabilities.map((c) => c.id)).toEqual(["auth"]);
  });

  it("reports tokenPresent truthfully for an unauthenticated public probe", () => {
    const report = classifyGithub({ probe: { ...base, tokenPresent: false } });
    expect(report.tokenPresent).toBe(false);
    expect(cap(report.capabilities, "auth").detail).toContain("unauthenticated");
  });
});

describe("checkGithubConnection", () => {
  it("maps a healthy probe bag to a ready report and carries tokenPresent through", async () => {
    const probes: GithubConnectProbes = {
      org: async () => typedOk({ teamsReadable: true }),
      repos: async () => typedOk({ sampled: 3 }),
      saml: async () => typedOk({ present: true }),
    };
    const report = await checkGithubConnection({ probes, tokenPresent: true });
    expect(report.ok).toBe(true);
    expect(report.tokenPresent).toBe(true);
  });
});
