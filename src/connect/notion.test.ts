import { describe, expect, it } from "vitest";
import { typedOk } from "../lib/result.js";
import { checkNotionConnection, classifyNotion, type NotionConnectProbes, type NotionProbe } from "./notion.js";
import type { ConnectCapability } from "./types.js";

function cap(caps: readonly ConnectCapability[], id: string): ConnectCapability {
  return caps.find((c) => c.id === id)!;
}

describe("classifyNotion", () => {
  const base: NotionProbe = {
    anyPerson: true,
    authReachable: true,
    emailVisible: true,
    pagesSampled: 3,
    usersSampled: 5,
  };

  it("a token with the read-user-email capability + shared pages is ready", () => {
    const report = classifyNotion({ probe: base });
    expect(report.ok).toBe(true);
    expect(cap(report.capabilities, "capability:read-user-email").status).toBe("ok");
  });

  it("flags a missing read-user-email capability when a person user has no email", () => {
    const report = classifyNotion({ probe: { ...base, emailVisible: false } });
    expect(report.ok).toBe(false);
    expect(cap(report.capabilities, "capability:read-user-email").status).toBe("missing");
  });

  it("distinguishes no-pages-visible from bad auth", () => {
    const report = classifyNotion({ probe: { ...base, pagesSampled: 0 } });
    expect(report.ok).toBe(false);
    expect(cap(report.capabilities, "read-probe").status).toBe("missing");
    expect(cap(report.capabilities, "auth").status).toBe("ok");
  });

  it("short-circuits when users.list is unreachable", () => {
    const report = classifyNotion({ probe: { ...base, authReachable: false } });
    expect(report.ok).toBe(false);
    expect(report.capabilities.map((c) => c.id)).toEqual(["auth"]);
  });
});

describe("checkNotionConnection", () => {
  it("maps a healthy probe bag to a ready report", async () => {
    const probes: NotionConnectProbes = {
      pages: async () => typedOk({ sampled: 1 }),
      users: async () => typedOk({ anyEmail: true, anyPerson: true, sampled: 4 }),
    };
    const report = await checkNotionConnection({ probes });
    expect(report.ok).toBe(true);
  });
});
