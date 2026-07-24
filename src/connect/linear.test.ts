import { describe, expect, it } from "vitest";
import { typedOk } from "../lib/result.js";
import { checkLinearConnection, classifyLinear, type LinearConnectProbes, type LinearProbe } from "./linear.js";
import type { ConnectCapability } from "./types.js";

function cap(caps: readonly ConnectCapability[], id: string): ConnectCapability {
  return caps.find((c) => c.id === id)!;
}

describe("classifyLinear", () => {
  const base: LinearProbe = {
    authReachable: true,
    curatedSampled: 2,
    issuesSampled: 1,
    projectsSampled: 1,
    usersSampled: 3,
  };

  it("a reachable key with visible activity is ready", () => {
    const report = classifyLinear({ probe: base });
    expect(report.ok).toBe(true);
    expect(cap(report.capabilities, "read-probe").status).toBe("ok");
    expect(cap(report.capabilities, "curated").status).toBe("ok");
  });

  it("treats an empty curated lane as a non-fatal warning", () => {
    const report = classifyLinear({ probe: { ...base, curatedSampled: 0 } });
    expect(report.ok).toBe(true);
    expect(cap(report.capabilities, "curated").status).toBe("warning");
  });

  it("reports no-data-visible when auth is ok but no core lane returns anything", () => {
    const report = classifyLinear({ probe: { ...base, issuesSampled: 0, projectsSampled: 0, usersSampled: 0 } });
    expect(report.ok).toBe(false);
    expect(cap(report.capabilities, "read-probe").status).toBe("missing");
  });

  it("short-circuits when the viewer query fails", () => {
    const report = classifyLinear({ probe: { ...base, authReachable: false } });
    expect(report.ok).toBe(false);
    expect(report.capabilities.map((c) => c.id)).toEqual(["auth"]);
  });
});

describe("checkLinearConnection", () => {
  it("maps a healthy probe bag to a ready report", async () => {
    const probes: LinearConnectProbes = {
      activity: async () => typedOk({ issues: 2, projects: 1, users: 4 }),
      curated: async () => typedOk({ documents: 1, initiatives: 1 }),
      viewer: async () => typedOk({ reachable: true }),
    };
    const report = await checkLinearConnection({ probes });
    expect(report.ok).toBe(true);
  });
});
