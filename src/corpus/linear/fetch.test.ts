import { describe, expect, it } from "vitest";
import type { RateScheduler } from "../../lib/resilience.js";
import { unwrap } from "../../lib/result.js";
import {
  fetchLinearActivity,
  type LinearApi,
  type LinearRequest,
  makeLinearApi,
  pageQueryVariables,
  parseLinearIssueIdentity,
  parseLinearIssueNode,
  parseLinearIssueRelations,
  shapeIssuesPage,
  shapeProjectsPage,
} from "./fetch.js";
import type { LinearIssueItem } from "./project.js";

/** One raw inline GraphQL issue node (relations + first comment page inline). */
function issueNode({ id, moreComments }: { id: string; moreComments: boolean }): Record<string, unknown> {
  return {
    assignee: { displayName: "Dana" },
    comments: {
      nodes: [
        { body: "hi", createdAt: "2026-05-02T00:00:00.000Z", id: `${id}-c1`, url: "u", user: { displayName: "Dana" } },
      ],
      pageInfo: { endCursor: moreComments ? "cc" : null, hasNextPage: moreComments },
    },
    createdAt: "2026-05-01T00:00:00.000Z",
    creator: { displayName: "Sam" },
    description: "the retriever drops old records",
    id,
    identifier: id,
    labels: { nodes: [{ name: "bug" }, { name: "retrieval" }] },
    project: { name: "Search quality" },
    state: { name: "In Progress" },
    team: { key: "ENG" },
    title: "recall regression",
    updatedAt: "2026-05-01T00:00:00.000Z",
    url: `https://linear.app/acme/issue/${id}`,
  };
}

/** A fake GraphQL transport: records every request, returns fixture data per query. */
function fakeRequest({
  calls,
  issueNodes,
}: {
  calls: string[];
  issueNodes: readonly Record<string, unknown>[];
}): LinearRequest {
  return async ({ query }) => {
    calls.push(
      query.includes("query Issues") ? "issues" : query.includes("query IssueComments") ? "comments" : "projects",
    );
    if (query.includes("query Issues")) {
      return { issues: { nodes: issueNodes, pageInfo: { endCursor: null, hasNextPage: false } } };
    }
    if (query.includes("query IssueComments")) {
      return {
        issue: {
          comments: {
            nodes: [
              {
                body: "later",
                createdAt: "2026-05-03T00:00:00.000Z",
                id: "extra",
                url: "u",
                user: { displayName: "Sam" },
              },
            ],
            pageInfo: { endCursor: null, hasNextPage: false },
          },
        },
      };
    }
    return { projects: { nodes: [], pageInfo: { endCursor: null, hasNextPage: false } } };
  };
}

/** A pass-through scheduler that never paces, so request-count tests run instantly (no wall time). */
const passthroughScheduler: RateScheduler = (task) => task();

describe("parseLinearIssueNode (pure)", () => {
  it("shapes an inline node with relations + comments; flags no further comment pages", () => {
    const rawNode = issueNode({ id: "ENG-42", moreComments: false });
    const parsed = parseLinearIssueNode({ node: rawNode })!;
    expect(parsed.item.identifier).toBe("ENG-42");
    expect(parsed.item.state).toBe("In Progress");
    expect(parsed.item.assignee).toBe("Dana");
    expect(parsed.item.team).toBe("ENG");
    expect(parsed.item.labels).toEqual(["bug", "retrieval"]);
    expect(parsed.item.comments.map((c) => c.id)).toEqual(["ENG-42-c1"]);
    expect(parsed.item.raw).toEqual(rawNode);
    expect(parsed.item.comments[0]!.raw).toEqual({
      body: "hi",
      createdAt: "2026-05-02T00:00:00.000Z",
      id: "ENG-42-c1",
      url: "u",
      user: { displayName: "Dana" },
    });
    expect(parsed.commentsHasNext).toBe(false);
  });

  it("returns undefined for a node with no identifier", () => {
    expect(parseLinearIssueNode({ node: { title: "x" } })).toBeUndefined();
  });
});

describe("makeLinearApi collapses the N+1 (one request per issue-page)", () => {
  it("fetches a page of N issues WITH relations + comments in ONE request", async () => {
    const calls: string[] = [];
    const nodes = [
      issueNode({ id: "ENG-1", moreComments: false }),
      issueNode({ id: "ENG-2", moreComments: false }),
      issueNode({ id: "ENG-3", moreComments: false }),
    ];
    const api = makeLinearApi({
      request: fakeRequest({ calls, issueNodes: nodes }),
      scheduler: passthroughScheduler,
      token: "x",
    });
    const page = await api.issues({ since: "2026-01-01" });
    expect(page.issues.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2", "ENG-3"]);
    expect(calls).toEqual(["issues"]); // ONE request for 3 issues + all their relations — not 3×7
  });

  it("only pages comments separately for an issue that has more than one page", async () => {
    const calls: string[] = [];
    const nodes = [issueNode({ id: "ENG-1", moreComments: true }), issueNode({ id: "ENG-2", moreComments: false })];
    const api = makeLinearApi({
      request: fakeRequest({ calls, issueNodes: nodes }),
      scheduler: passthroughScheduler,
      token: "x",
    });
    const page = await api.issues({ since: "2026-01-01" });
    expect(calls).toEqual(["issues", "comments"]); // one issue-page + one comment-page (only ENG-1 needed it)
    const eng1 = page.issues.find((i) => i.identifier === "ENG-1")!;
    expect(eng1.comments.map((c) => c.id)).toEqual(["ENG-1-c1", "extra"]); // inline + paginated comments merged
  });
});

describe("pageQueryVariables (pure — shared by the issue + project lanes)", () => {
  it("builds the updatedAt>=since filter with no cursor on the first page", () => {
    expect(pageQueryVariables({ cursor: undefined, since: "2026-01-01" })).toEqual({
      filter: { updatedAt: { gte: "2026-01-01" } },
      first: 50,
    });
  });

  it("adds the `after` cursor on a subsequent page", () => {
    expect(pageQueryVariables({ cursor: "abc", since: "2026-01-01" })).toEqual({
      after: "abc",
      filter: { updatedAt: { gte: "2026-01-01" } },
      first: 50,
    });
  });
});

describe("shapeIssuesPage / shapeProjectsPage (pure)", () => {
  it("parses issue nodes and surfaces the next cursor when there is another page", () => {
    const shaped = shapeIssuesPage({
      data: {
        issues: {
          nodes: [issueNode({ id: "ENG-1", moreComments: false }), { title: "no-identifier" }],
          pageInfo: { endCursor: "next", hasNextPage: true },
        },
      },
    });
    expect(shaped.parsed.map((p) => p.item.identifier)).toEqual(["ENG-1"]); // the id-less node dropped
    expect(shaped.nextCursor).toBe("next");
  });

  it("omits the next cursor when there is no further page", () => {
    const shaped = shapeProjectsPage({
      data: {
        projects: {
          nodes: [{ id: "p1", name: "Quality", updatedAt: "2026-05-01T00:00:00.000Z", url: "u" }],
          pageInfo: { endCursor: null, hasNextPage: false },
        },
      },
    });
    expect(shaped.projects.map((p) => p.id)).toEqual(["p1"]);
    expect(shaped.nextCursor).toBeUndefined();
  });
});

const issue = (identifier: string): LinearIssueItem => ({
  comments: [],
  identifier,
  labels: [],
  title: `issue ${identifier}`,
  tsIso: "2026-05-01T00:00:00.000Z",
  url: `https://linear.app/acme/issue/${identifier}`,
});

describe("fetchLinearActivity", () => {
  it("pages issues + projects to exhaustion via the injected seam", async () => {
    const api: LinearApi = {
      issues: async ({ cursor }) =>
        cursor === undefined ? { issues: [issue("ENG-1")], nextCursor: "c2" } : { issues: [issue("ENG-2")] },
      projects: async () => ({
        projects: [{ id: "p1", name: "Quality", tsIso: "2026-05-01T00:00:00.000Z", url: "u" }],
      }),
    };
    const result = unwrap(await fetchLinearActivity({ api, window: { since: "2026-01-01", until: "2026-06-01" } }));
    expect(result.issues.map((i) => i.identifier)).toEqual(["ENG-1", "ENG-2"]);
    expect(result.projects.map((p) => p.id)).toEqual(["p1"]);
  });

  it("threads the window `since` to BOTH issues and projects (projects must not ignore it)", async () => {
    const seenIssueSince: string[] = [];
    const seenProjectSince: string[] = [];
    const api: LinearApi = {
      issues: async ({ since }) => {
        seenIssueSince.push(since);
        return { issues: [] };
      },
      projects: async ({ since }) => {
        seenProjectSince.push(since);
        return { projects: [] };
      },
    };
    await fetchLinearActivity({ api, window: { since: "2026-04-01", until: "2026-06-01" } });
    expect(seenIssueSince).toEqual(["2026-04-01"]);
    expect(seenProjectSince).toEqual(["2026-04-01"]);
  });

  it("pages projects to exhaustion, not just the first page", async () => {
    const api: LinearApi = {
      issues: async () => ({ issues: [] }),
      projects: async ({ cursor }) =>
        cursor === undefined
          ? { nextCursor: "p2", projects: [{ id: "p1", name: "A", tsIso: "2026-05-01T00:00:00.000Z", url: "u" }] }
          : { projects: [{ id: "p2", name: "B", tsIso: "2026-05-01T00:00:00.000Z", url: "u" }] },
    };
    const result = unwrap(await fetchLinearActivity({ api, window: { since: "2026-01-01", until: "2026-06-01" } }));
    expect(result.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("is fatal when the seam throws", async () => {
    const api: LinearApi = {
      issues: async () => {
        throw new Error("rate limited");
      },
      projects: async () => ({ projects: [] }),
    };
    expect((await fetchLinearActivity({ api, window: { since: "2026-01-01", until: "2026-06-01" } })).ok).toBe(false);
  });
});

describe("parseLinearIssueIdentity", () => {
  it("falls back title and id to the identifier and keeps present fields", () => {
    const identity = parseLinearIssueIdentity({ node: { identifier: "ENG-1", updatedAt: "2026-01-01T00:00:00Z" } })!;
    expect(identity.identifier).toBe("ENG-1");
    expect(identity.title).toBe("ENG-1");
    expect(identity.tsIso).toBe("2026-01-01T00:00:00Z");
  });

  it("drops the issue (undefined) when there is no identifier", () => {
    expect(parseLinearIssueIdentity({ node: { title: "no id" } })).toBeUndefined();
  });

  it("omits description when absent", () => {
    const identity = parseLinearIssueIdentity({ node: { identifier: "ENG-2" } })!;
    expect(Object.hasOwn(identity, "description")).toBe(false);
  });
});

describe("parseLinearIssueRelations", () => {
  it("extracts nested state/team/project and people display names", () => {
    expect(
      parseLinearIssueRelations({
        node: {
          assignee: { displayName: "Dana" },
          creator: { displayName: "Sam" },
          project: { name: "Atlas" },
          state: { name: "In Progress" },
          team: { key: "ENG" },
        },
      }),
    ).toEqual({ assignee: "Dana", author: "Sam", project: "Atlas", state: "In Progress", team: "ENG" });
  });

  it("returns an empty object when all relations are missing", () => {
    expect(parseLinearIssueRelations({ node: {} })).toEqual({});
  });
});
