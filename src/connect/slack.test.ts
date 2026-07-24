import { describe, expect, it } from "vitest";
import type { IngestError } from "../lib/ingestError.js";
import { type TypedResult, typedErr, typedOk } from "../lib/result.js";
import {
  checkSlackConnection,
  classifySlack,
  SLACK_REQUIRED_USER_SCOPES,
  type SlackConnectProbes,
  type SlackProbe,
} from "./slack.js";
import type { ConnectCapability } from "./types.js";

/** Look up one capability by id (non-null asserted — the test knows it exists). */
function cap(caps: readonly ConnectCapability[], id: string): ConnectCapability {
  return caps.find((c) => c.id === id)!;
}

const errProbe = <T>(): Promise<TypedResult<T, IngestError>> =>
  Promise.resolve(typedErr({ kind: "http", message: "boom", operation: "t" }));

describe("classifySlack", () => {
  const base: SlackProbe = {
    authReachable: true,
    channelsSampled: 4,
    emailVisible: true,
    humanMembersSampled: 5,
    membersSampled: 6,
    tokenKind: "user",
  };

  it("a full user token with the email scope + visible data is ready", () => {
    const report = classifySlack({ probe: base });
    expect(report.ok).toBe(true);
    expect(cap(report.capabilities, "scope:users:read.email").status).toBe("ok");
    expect(cap(report.capabilities, "token-breadth").status).toBe("ok");
  });

  it("flags a missing users:read.email scope when sampled humans expose no email", () => {
    const report = classifySlack({ probe: { ...base, emailVisible: false } });
    expect(report.ok).toBe(false);
    expect(cap(report.capabilities, "scope:users:read.email").status).toBe("missing");
  });

  it("only WARNS on the email scope when the sample had no human members (all bots)", () => {
    const report = classifySlack({ probe: { ...base, emailVisible: false, humanMembersSampled: 0 } });
    expect(cap(report.capabilities, "scope:users:read.email").status).toBe("warning");
  });

  it("warns (does not fail) on a bot token's reduced breadth", () => {
    const report = classifySlack({ probe: { ...base, tokenKind: "bot" } });
    expect(report.ok).toBe(true);
    expect(cap(report.capabilities, "token-breadth").status).toBe("warning");
  });

  it("reports a no-data-visible failure when auth is ok but nothing is readable", () => {
    const report = classifySlack({
      probe: { ...base, channelsSampled: 0, emailVisible: false, humanMembersSampled: 0, membersSampled: 0 },
    });
    expect(report.ok).toBe(false);
    expect(cap(report.capabilities, "read-probe").status).toBe("missing");
    expect(cap(report.capabilities, "scope:users:read.email").status).toBe("warning");
  });

  it("short-circuits to a single auth failure when auth is unreachable", () => {
    const report = classifySlack({ probe: { ...base, authReachable: false } });
    expect(report.ok).toBe(false);
    expect(report.capabilities.map((c) => c.id)).toEqual(["auth"]);
    expect(report.errors).toEqual(["slack: auth.test did not reach the workspace"]);
  });
});

describe("checkSlackConnection", () => {
  it("maps a healthy probe bag to a ready report", async () => {
    const probes: SlackConnectProbes = {
      auth: async () => typedOk({ reachable: true }),
      channels: async () => typedOk({ sampled: 2 }),
      users: async () => typedOk({ anyHumanEmail: true, humans: 3, sampled: 3 }),
    };
    const report = await checkSlackConnection({ probes, tokenKind: "user" });
    expect(report.ok).toBe(true);
  });

  it("treats a failed auth probe as unreachable", async () => {
    const probes: SlackConnectProbes = {
      auth: () => errProbe(),
      channels: async () => typedOk({ sampled: 2 }),
      users: async () => typedOk({ anyHumanEmail: true, humans: 3, sampled: 3 }),
    };
    const report = await checkSlackConnection({ probes, tokenKind: "user" });
    expect(report.ok).toBe(false);
    expect(report.capabilities.map((c) => c.id)).toEqual(["auth"]);
  });
});

describe("SLACK_REQUIRED_USER_SCOPES", () => {
  it("carries the email scope member hydration needs", () => {
    expect(SLACK_REQUIRED_USER_SCOPES).toContain("users:read.email");
  });
});
