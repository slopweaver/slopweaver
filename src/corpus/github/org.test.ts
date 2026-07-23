import { describe, expect, it } from "vitest";
import { err, ok, type Result, unwrap } from "../../lib/result.js";
import {
  enumerateOrgRepos,
  fetchGithubStructures,
  type GithubOrgApi,
  globToRegExp,
  projectOrgRow,
  projectRepoRow,
  projectTeamRow,
  selectRepoNames,
} from "./org.js";

const AT = "2026-07-20T00:00:00.000Z";

describe("globToRegExp", () => {
  it("matches a `*` glob as any run and stays anchored", () => {
    expect(globToRegExp({ glob: "app-*" }).test("app-web")).toBe(true);
    expect(globToRegExp({ glob: "app-*" }).test("lib-app-web")).toBe(false);
  });
});

describe("selectRepoNames", () => {
  it("keeps includes, drops excludes, and applies the cap with a warning", () => {
    const selection = selectRepoNames({
      cap: 2,
      exclude: ["*-archive"],
      include: ["app-*"],
      names: ["app-web", "app-api", "app-old-archive", "app-cli", "infra"],
    });
    expect(selection.selected).toEqual(["app-api", "app-cli"]);
    expect(selection.excluded).toEqual(["app-old-archive"]);
    expect(selection.cappedCount).toBe(1);
    // Every skip is logged — include filter, exclude globs, and cap (no silent truncation).
    expect(selection.warnings).toEqual([
      "github: 1 repo(s) filtered out by --include-repo (4 matched)",
      "github: 1 repo(s) skipped by --exclude-repo",
      "github: repo cap 2 applied — 1 of 3 repo(s) skipped",
    ]);
  });

  it("keeps everything with no include/exclude/cap", () => {
    expect(selectRepoNames({ cap: undefined, exclude: [], include: [], names: ["b", "a"] }).selected).toEqual([
      "a",
      "b",
    ]);
  });
});

describe("projectOrgRow / projectRepoRow / projectTeamRow", () => {
  it("projects an org row", () => {
    const row = projectOrgRow({
      fetchedAtIso: AT,
      raw: { html_url: "https://github.com/acme", login: "acme", public_repos: 12 },
    })!;
    expect(row.kind).toBe("org");
    expect(row.sourceId).toBe("acme");
    expect(row.attrs["publicRepos"]).toBe(12);
  });

  it("projects a repo row with visibility/archived attrs", () => {
    const row = projectRepoRow({
      fetchedAtIso: AT,
      raw: {
        archived: true,
        default_branch: "main",
        full_name: "acme/app",
        language: "TypeScript",
        name: "app",
        private: true,
      },
    })!;
    expect(row.sourceId).toBe("acme/app");
    expect(row.attrs).toEqual({
      archived: true,
      defaultBranch: "main",
      fork: false,
      language: "TypeScript",
      private: true,
    });
  });

  it("projects a team row with member + repo-permission relations", () => {
    const row = projectTeamRow({
      fetchedAtIso: AT,
      members: [{ login: "octocat" }, { login: "hubber" }],
      raw: { name: "Platform", slug: "platform" },
      repos: [{ full_name: "acme/app", permission: "admin" }],
    })!;
    expect(row.relations).toEqual([
      { targetId: "github:octocat", targetKind: "person", targetSource: "person", type: "member" },
      { targetId: "github:hubber", targetKind: "person", targetSource: "person", type: "member" },
      {
        attrs: { permission: "admin" },
        targetId: "acme/app",
        targetKind: "repo",
        targetSource: "github",
        type: "permission",
      },
    ]);
  });
});

/** A fake org seam over seeded pages. `teamsResult` controls the read:org degrade path. */
function fakeApi({
  repos = [
    { full_name: "acme/app", name: "app" },
    { full_name: "acme/lib", name: "lib" },
  ],
  teamsResult = ok([{ name: "Platform", slug: "platform" }]),
  org = { login: "acme" },
}: {
  repos?: readonly unknown[];
  teamsResult?: Result<readonly unknown[]>;
  org?: unknown;
} = {}): GithubOrgApi {
  return {
    getOrg: async () => org,
    listRepos: async ({ page }) => (page === 1 ? repos : []),
    listTeamMembers: async () => [{ login: "octocat" }],
    listTeamRepos: async () => [{ full_name: "acme/app", permission: "push" }],
    listTeams: async () => teamsResult,
  };
}

describe("enumerateOrgRepos", () => {
  it("returns the selected repo coordinates", async () => {
    const result = unwrap(
      await enumerateOrgRepos({ api: fakeApi({}), cap: undefined, exclude: ["lib"], include: [], org: "acme" }),
    );
    expect(result.repos).toEqual([{ owner: "acme", repo: "app" }]);
  });
});

describe("fetchGithubStructures", () => {
  it("captures org + repo + team rows (+ relations) from the seam", async () => {
    const result = unwrap(
      await fetchGithubStructures({
        api: fakeApi({}),
        cap: undefined,
        exclude: [],
        fetchedAtIso: AT,
        include: [],
        org: "acme",
      }),
    );
    const kinds = result.rows.map((r) => r.kind).toSorted();
    expect(kinds).toEqual(["org", "repo", "repo", "team"]);
    expect(result.repos).toEqual([
      { owner: "acme", repo: "app" },
      { owner: "acme", repo: "lib" },
    ]);
  });

  it("DEGRADES to a warning (no team rows) when teams need read:org", async () => {
    const result = unwrap(
      await fetchGithubStructures({
        api: fakeApi({
          teamsResult: err(["github: teams unavailable (403) — needs an org-admin token with read:org"]),
        }),
        cap: undefined,
        exclude: [],
        fetchedAtIso: AT,
        include: [],
        org: "acme",
      }),
    );
    expect(result.rows.some((r) => r.kind === "team")).toBe(false);
    expect(result.warnings).toContain("github: teams unavailable (403) — needs an org-admin token with read:org");
  });

  it("DEGRADES a per-team members failure to a warning (team row still lands, no crash)", async () => {
    const flakyApi: GithubOrgApi = {
      ...fakeApi({}),
      listTeamMembers: async () => {
        throw new Error("403 forbidden");
      },
    };
    const result = unwrap(
      await fetchGithubStructures({
        api: flakyApi,
        cap: undefined,
        exclude: [],
        fetchedAtIso: AT,
        include: [],
        org: "acme",
      }),
    );
    expect(result.rows.some((r) => r.kind === "team")).toBe(true);
    expect(result.warnings).toContain("github team platform members unavailable: 403 forbidden");
  });

  it("skips the org row + warns when org info is unavailable", async () => {
    const noOrgApi: GithubOrgApi = { ...fakeApi({}), getOrg: async () => undefined };
    const result = unwrap(
      await fetchGithubStructures({
        api: noOrgApi,
        cap: undefined,
        exclude: [],
        fetchedAtIso: AT,
        include: [],
        org: "acme",
      }),
    );
    expect(result.rows.some((r) => r.kind === "org")).toBe(false);
    expect(result.warnings).toContain("github: org info unavailable (orgs.get) — org row skipped");
  });
});
