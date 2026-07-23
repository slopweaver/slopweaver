import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import {
  fetchSlackStructures,
  planChannelMembership,
  projectChannelRow,
  projectUsergroupRow,
  projectWorkspaceRow,
  type SlackStructuresApi,
} from "./structures.js";

const AT = "2026-07-20T00:00:00.000Z";

describe("projectWorkspaceRow", () => {
  it("projects the workspace + enterprise fields", () => {
    const row = projectWorkspaceRow({
      auth: { enterprise_id: "E1", enterprise_name: "Acme Grid" },
      fetchedAtIso: AT,
      team: { domain: "acme", id: "T1", name: "Acme" },
    })!;
    expect(row.sourceId).toBe("T1");
    expect(row.identity.url).toBe("https://acme.slack.com");
    expect(row.attrs).toEqual({ enterpriseId: "E1", enterpriseName: "Acme Grid" });
  });
});

describe("projectChannelRow", () => {
  it("captures topic/purpose/flags + member relations when membership was fetched", () => {
    const row = projectChannelRow({
      fetchedAtIso: AT,
      memberIds: ["U1", "U2"],
      membershipFetched: true,
      raw: { id: "C1", is_private: false, name: "general", purpose: { value: "chat" }, topic: { value: "hi" } },
    })!;
    expect(row.attrs).toMatchObject({ archived: false, private: false, purpose: "chat", topic: "hi" });
    expect(row.relations).toEqual([
      { targetId: "slack:U1", targetKind: "person", targetSource: "person", type: "member" },
      { targetId: "slack:U2", targetKind: "person", targetSource: "person", type: "member" },
    ]);
    expect(row.warnings).toEqual([]);
  });

  it("warns (not silently empty) when membership was NOT fetched", () => {
    const row = projectChannelRow({
      fetchedAtIso: AT,
      memberIds: [],
      membershipFetched: false,
      raw: { id: "C2", name: "random" },
    })!;
    expect(row.relations).toEqual([]);
    expect(row.warnings).toEqual(["membership not fetched (archived or past the membership cap)"]);
  });
});

describe("projectUsergroupRow", () => {
  it("projects a usergroup with its inline members", () => {
    const row = projectUsergroupRow({
      fetchedAtIso: AT,
      raw: { handle: "eng", id: "S1", name: "Engineers", users: ["U1"] },
    })!;
    expect(row.identity.slug).toBe("eng");
    expect(row.relations).toEqual([
      { targetId: "slack:U1", targetKind: "person", targetSource: "person", type: "member" },
    ]);
  });
});

describe("planChannelMembership", () => {
  it("skips archived channels and caps active ones, logging the skip", () => {
    const plan = planChannelMembership({
      cap: 1,
      channels: [{ id: "C1" }, { id: "C2" }, { id: "C3", is_archived: true }],
    });
    expect(plan.entries.map((e) => [e.id, e.fetchMembership])).toEqual([
      ["C1", true],
      ["C2", false],
      ["C3", false],
    ]);
    expect(plan.warnings).toEqual(["slack: channel-membership cap 1 applied — 1 active channel(s) not resolved"]);
  });
});

/** A fake Slack structure seam over one seeded page. */
function fakeApi(): SlackStructuresApi {
  return {
    authTest: async () => ({ enterprise_id: "E1" }),
    channelMembers: async ({ channel }) => (channel === "C1" ? ["U1", "U2"] : []),
    listChannels: async () => ({
      channels: [
        { id: "C1", name: "general" },
        { id: "C2", is_archived: true, name: "old" },
      ],
    }),
    listUsergroups: async () => [{ handle: "eng", id: "S1", name: "Engineers", users: ["U1"] }],
    teamInfo: async () => ({ domain: "acme", id: "T1", name: "Acme" }),
  };
}

describe("fetchSlackStructures", () => {
  it("hydrates workspace + channels (membership for active only) + usergroups", async () => {
    const result = unwrap(await fetchSlackStructures({ api: fakeApi(), fetchedAtIso: AT, membershipCap: 50 }));
    expect(result.rows.map((r) => r.kind).toSorted()).toEqual(["channel", "channel", "org", "usergroup"]);
    const general = result.rows.find((r) => r.sourceId === "C1")!;
    expect(general.relations).toHaveLength(2);
    const archived = result.rows.find((r) => r.sourceId === "C2")!;
    expect(archived.warnings).toEqual(["membership not fetched (archived or past the membership cap)"]);
  });
});
