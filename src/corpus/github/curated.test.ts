import { describe, expect, it } from "vitest";
import {
  fetchGithubCurated,
  type GithubCuratedApi,
  type GithubCuratedItems,
  issueNumbersOf,
  parseCodeowners,
  parseDiscussionNode,
  parseMilestoneNode,
  parseReleaseNode,
  projectGithubCurated,
} from "./curated.js";

describe("pure shapers", () => {
  it("parses a discussion node with category + author", () => {
    const node = {
      author: { login: "sam" },
      body: "text",
      category: { name: "RFC" },
      number: 12,
      title: "RFC: x",
      updatedAt: "2026-05-01T00:00:00Z",
      url: "u",
    };
    expect(parseDiscussionNode({ node })).toEqual({
      author: "sam",
      body: "text",
      category: "RFC",
      number: 12,
      title: "RFC: x",
      tsIso: "2026-05-01T00:00:00Z",
      url: "u",
    });
  });

  it("parses a release keyed by tag, and drops a tag-less one", () => {
    expect(
      parseReleaseNode({
        raw: { html_url: "u", name: "v1", published_at: "2026-05-01T00:00:00Z", tag_name: "v1.0.0" },
      })!.tag,
    ).toBe("v1.0.0");
    expect(parseReleaseNode({ raw: { name: "no tag" } })).toBe(undefined);
  });

  it("parses a milestone and reads grouped issue numbers", () => {
    expect(parseMilestoneNode({ raw: { html_url: "u", number: 3, state: "open", title: "M1" } })!.number).toBe(3);
    expect(issueNumbersOf({ raw: [{ number: 5 }, { number: 6 }, { title: "no number" }] })).toEqual([5, 6]);
  });

  it("parses CODEOWNERS into distinct owners, skipping comments + blanks", () => {
    const content = "# owners\n*        @acme/platform\ndocs/    @acme/platform @jill\n";
    expect(parseCodeowners({ content, path: ".github/CODEOWNERS" })).toEqual({
      owners: ["@acme/platform", "@jill"],
      path: ".github/CODEOWNERS",
      text: content,
    });
  });
});

describe("projectGithubCurated", () => {
  const items: GithubCuratedItems = {
    codeowners: { owners: ["@acme/platform", "@jill"], path: ".github/CODEOWNERS", text: "* @acme/platform @jill" },
    discussions: [
      { body: "we decided to adopt X", number: 12, title: "RFC: adopt X", tsIso: "2026-05-01T00:00:00Z", url: "u" },
    ],
    milestones: [
      { description: "ship it", issueNumbers: [5, 6], number: 3, title: "M1", tsIso: "2026-05-01T00:00:00Z", url: "u" },
    ],
    releases: [{ body: "notes", name: "v1", tag: "v1.0.0", tsIso: "2026-05-01T00:00:00Z", url: "u" }],
  };

  it("projects a discussion classified `decision` (RFC keyword)", () => {
    const record = projectGithubCurated({ items, repo: "acme/api" }).find((r) => r.kind === "discussion")!;
    expect(record.sourceId).toBe("discussion:#12");
    expect(record.attrs!["classification"]).toBe("decision");
  });

  it("projects a release classified `status`", () => {
    const record = projectGithubCurated({ items, repo: "acme/api" }).find((r) => r.kind === "release")!;
    expect(record.sourceId).toBe("release:v1.0.0");
    expect(record.attrs!["classification"]).toBe("status");
  });

  it("projects a milestone with grouping edges to its issues", () => {
    const record = projectGithubCurated({ items, repo: "acme/api" }).find((r) => r.kind === "milestone")!;
    expect(record.attrs!["curatedEdges"]).toEqual(["milestone|github:#5", "milestone|github:#6"]);
  });

  it("projects CODEOWNERS classified `ownership` with `owns` edges to teams/users", () => {
    const record = projectGithubCurated({ items, repo: "acme/api" }).find((r) => r.kind === "codeowners")!;
    expect(record.attrs!["classification"]).toBe("ownership");
    expect(record.attrs!["curatedEdges"]).toEqual(["owns|github:team:acme/platform", "owns|github:user:jill"]);
  });
});

describe("fetchGithubCurated — best-effort", () => {
  const repo = { owner: "acme", repo: "api" };

  it("attaches each milestone's grouped issue numbers", async () => {
    const api: GithubCuratedApi = {
      codeowners: async () => undefined,
      discussions: async () => [],
      milestoneIssues: async () => [{ number: 5 }, { number: 6 }],
      milestones: async () => [{ html_url: "u", number: 3, title: "M1" }],
      releases: async () => [],
    };
    const result = await fetchGithubCurated({ api, repo });
    expect(result.items.milestones[0]!.issueNumbers).toEqual([5, 6]);
    expect(result.warnings).toEqual([]);
  });

  it("degrades a failing lane (e.g. discussions disabled) to a warning, never throwing", async () => {
    const api: GithubCuratedApi = {
      codeowners: async () => undefined,
      discussions: async () => {
        throw new Error("Discussions disabled");
      },
      milestoneIssues: async () => [],
      milestones: async () => [],
      releases: async () => [],
    };
    const result = await fetchGithubCurated({ api, repo });
    expect(result.items.discussions).toEqual([]);
    expect(result.warnings.some((w) => w.includes("discussions skipped"))).toBe(true);
  });

  it("a genuinely-absent CODEOWNERS is quiet, but a real fetch failure warns", async () => {
    const base: GithubCuratedApi = {
      codeowners: async () => undefined,
      discussions: async () => [],
      milestoneIssues: async () => [],
      milestones: async () => [],
      releases: async () => [],
    };
    const absent = await fetchGithubCurated({ api: base, repo });
    expect(absent.items.codeowners).toBe(undefined);
    expect(absent.warnings).toEqual([]);

    const failing: GithubCuratedApi = {
      ...base,
      codeowners: async () => {
        throw new Error("403 forbidden");
      },
    };
    const failed = await fetchGithubCurated({ api: failing, repo });
    expect(failed.warnings.some((w) => w.includes("codeowners skipped"))).toBe(true);
  });
});
