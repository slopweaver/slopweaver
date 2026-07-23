import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import type { LinearRequest } from "./fetch.js";
import {
  fetchLinearStructures,
  projectLinearCycles,
  projectLinearOrg,
  projectLinearStates,
  projectLinearTeam,
  structuresFromTeamsPage,
} from "./structures.js";

const AT = "2026-07-20T00:00:00.000Z";

const TEAM_NODE = {
  cycles: {
    nodes: [{ endsAt: "2026-07-14", id: "cyc1", name: "Cycle 5", number: 5, progress: 0.5, startsAt: "2026-07-01" }],
  },
  description: "owns the platform",
  id: "team1",
  key: "PLAT",
  members: { nodes: [{ id: "user1" }, { id: "user2" }] },
  name: "Platform",
  private: false,
  states: { nodes: [{ id: "st1", name: "In Progress", position: 1, type: "started" }] },
};

describe("projectLinearOrg", () => {
  it("projects the organization row", () => {
    const row = projectLinearOrg({
      fetchedAtIso: AT,
      raw: { id: "org1", name: "Acme", samlEnabled: true, urlKey: "acme", userCount: 30 },
    })!;
    expect(row.sourceId).toBe("org1");
    expect(row.attrs).toEqual({ samlEnabled: true, userCount: 30 });
  });
});

describe("projectLinearTeam", () => {
  it("projects a team with member relations", () => {
    const row = projectLinearTeam({ fetchedAtIso: AT, node: TEAM_NODE })!;
    expect(row.identity.slug).toBe("PLAT");
    expect(row.relations).toEqual([
      { targetId: "linear:user1", targetKind: "person", targetSource: "person", type: "member" },
      { targetId: "linear:user2", targetKind: "person", targetSource: "person", type: "member" },
    ]);
  });
});

describe("projectLinearStates / projectLinearCycles", () => {
  it("binds each state to its team", () => {
    const states = projectLinearStates({ fetchedAtIso: AT, node: TEAM_NODE });
    expect(states[0]!.attrs).toEqual({ position: 1, type: "started" });
    expect(states[0]!.relations).toEqual([
      { targetId: "team1", targetKind: "team", targetSource: "linear", type: "state_for" },
    ]);
  });

  it("binds each cycle to its team", () => {
    const cycles = projectLinearCycles({ fetchedAtIso: AT, node: TEAM_NODE });
    expect(cycles[0]!.sourceId).toBe("cyc1");
    expect(cycles[0]!.relations).toEqual([
      { targetId: "team1", targetKind: "team", targetSource: "linear", type: "cycle_for" },
    ]);
  });
});

describe("structuresFromTeamsPage", () => {
  it("emits team + state + cycle rows and skips a malformed node", () => {
    const page = structuresFromTeamsPage({
      data: { teams: { nodes: [TEAM_NODE, { key: "no-id" }] } },
      fetchedAtIso: AT,
    });
    expect(page.rows.map((r) => r.kind).toSorted()).toEqual(["cycle", "team", "workflow_state"]);
  });
});

/** A fake transport routing ORG_QUERY vs TEAMS_QUERY by query content. */
function fakeRequest(): LinearRequest {
  return async ({ query }) => {
    if (query.includes("organization {")) {
      return { organization: { id: "org1", name: "Acme", urlKey: "acme" } };
    }
    return { teams: { nodes: [TEAM_NODE], pageInfo: { hasNextPage: false } } };
  };
}

describe("fetchLinearStructures", () => {
  it("hydrates org + team + states + cycles deterministically", async () => {
    const result = unwrap(await fetchLinearStructures({ fetchedAtIso: AT, request: fakeRequest() }));
    expect(result.rows.map((r) => r.kind).toSorted()).toEqual(["cycle", "org", "team", "workflow_state"]);
  });
});
