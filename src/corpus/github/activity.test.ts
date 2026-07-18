import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import { makeFetchGithubActivity, parseActivity } from "./activity.js";

const prNode = {
  comments: { nodes: [{ author: { login: "c1" }, body: "a comment", createdAt: "2024-01-01T11:00:00Z", url: "u2" }] },
  commits: { nodes: [{ commit: { statusCheckRollup: { state: "SUCCESS" } } }] },
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: "APPROVED",
  reviews: {
    nodes: [
      { author: { login: "rev" }, body: "lgtm", state: "APPROVED", submittedAt: "2024-01-01T10:00:00Z", url: "u1" },
    ],
  },
  reviewThreads: {
    nodes: [
      {
        comments: {
          nodes: [{ author: { login: "c2" }, body: "thread", createdAt: "2024-01-01T12:00:00Z", url: "u3" }],
        },
        isResolved: true,
      },
    ],
  },
  state: "OPEN",
  timelineItems: {
    nodes: [{ __typename: "MergedEvent", actor: { login: "merger" }, createdAt: "2024-01-02T00:00:00Z" }],
  },
  updatedAt: "2024-01-02T00:00:00Z",
};

describe("parseActivity", () => {
  it("parses a PR node — reviews, issue+thread comments, checks, timeline", () => {
    const activity = parseActivity({ isPr: true, node: prNode });
    expect(activity.state).toBe("OPEN");
    expect(activity.checks).toBe("SUCCESS");
    expect(activity.reviews).toHaveLength(1);
    expect(activity.comments).toHaveLength(2);
    expect(activity.comments[1]!.resolved).toBe(true);
    expect(activity.timeline).toEqual([{ actor: "merger", tsIso: "2024-01-02T00:00:00Z", type: "Merged" }]);
  });

  it("an issue node carries no reviews and degrades missing fields to empty", () => {
    const activity = parseActivity({ isPr: false, node: { comments: { nodes: [] }, state: "CLOSED" } });
    expect(activity.reviews).toEqual([]);
    expect(activity.checks).toBeUndefined();
    expect(activity.comments).toEqual([]);
  });
});

describe("makeFetchGithubActivity", () => {
  const repo = { owner: "o", repo: "r" };

  it("returns the parsed activity for a present node", async () => {
    const fetch = makeFetchGithubActivity({ graphql: async () => ({ repository: { pullRequest: prNode } }) });
    const result = await fetch({ isPr: true, number: 1, repo });
    expect(result.ok).toBe(true);
    expect(unwrap(result).checks).toBe("SUCCESS");
  });

  it("errs (not throws) when the item is absent", async () => {
    const fetch = makeFetchGithubActivity({ graphql: async () => ({ repository: { pullRequest: null } }) });
    expect((await fetch({ isPr: true, number: 9, repo })).ok).toBe(false);
  });

  it("errs when the transport throws", async () => {
    const fetch = makeFetchGithubActivity({
      graphql: async () => {
        throw new Error("rate limited");
      },
    });
    expect((await fetch({ isPr: true, number: 1, repo })).ok).toBe(false);
  });
});
