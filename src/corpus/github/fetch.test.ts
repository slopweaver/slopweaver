import { describe, expect, it } from "vitest";
import { err, ok, type Result, unwrap, unwrapErr } from "../../lib/result.js";
import type { GithubActivity } from "./activity.js";
import { makeGithubFetchItems, type SearchIssues } from "./fetch.js";

const repo = { owner: "o", repo: "r" };
const window = { since: "2024-01-01", until: "2024-01-03" };

const hit = ({ n, isPr }: { n: number; isPr: boolean }): unknown => ({
  created_at: "2024-01-01T00:00:00Z",
  html_url: `url${String(n)}`,
  number: n,
  title: `t${String(n)}`,
  updated_at: "2024-01-02T00:00:00Z",
  user: { login: "u" },
  ...(isPr ? { pull_request: {} } : {}),
});

/** page 1 returns `items`, later pages are empty (a short page stops the loop). */
const search =
  (items: readonly unknown[]): SearchIssues =>
  async ({ page }) => ({ data: { items: page === 1 ? items : [] } });

const activityStub: GithubActivity = {
  comments: [],
  reviews: [],
  state: "OPEN",
  timeline: [],
  updatedAtIso: "2024-01-02T00:00:00Z",
};

describe("makeGithubFetchItems", () => {
  it("maps hits to items, discriminating PR vs issue", async () => {
    const fetchItems = makeGithubFetchItems({
      searchIssues: search([hit({ isPr: true, n: 1 }), hit({ isPr: false, n: 2 })]),
    });
    const result = await fetchItems({ repo, window });
    expect(unwrap(result).map((i) => i.kind)).toEqual(["pr", "issue"]);
  });

  it("keeps the raw search hit on the shaped item", async () => {
    const rawHit = hit({ isPr: true, n: 1 });
    const fetchItems = makeGithubFetchItems({ searchIssues: search([rawHit]) });
    const items = unwrap(await fetchItems({ repo, window }));
    expect(items[0]!.raw).toEqual(rawHit);
  });

  it("attaches activity on enrich success and ships the item bare on enrich failure", async () => {
    const fetchActivity = async ({ number }: { number: number }): Promise<Result<GithubActivity>> =>
      number === 1 ? ok(activityStub) : err(["no activity"]);
    const fetchItems = makeGithubFetchItems({
      fetchActivity,
      searchIssues: search([hit({ isPr: true, n: 1 }), hit({ isPr: true, n: 2 })]),
    });
    const items = unwrap(await fetchItems({ repo, window }));
    expect(items[0]!.activity).toBeDefined();
    expect(items[1]!.activity).toBeUndefined();
  });

  it("a search failure is fatal (err), not a partial write", async () => {
    const fetchItems = makeGithubFetchItems({
      searchIssues: async () => {
        throw new Error("boom");
      },
    });
    expect((await fetchItems({ repo, window })).ok).toBe(false);
  });

  it("drops a hit missing a core field and surfaces the skip count (never silent)", async () => {
    const missingTitle = { html_url: "url9", number: 9, updated_at: "2024-01-02T00:00:00Z" }; // no title
    const fetchItems = makeGithubFetchItems({
      searchIssues: search([hit({ isPr: true, n: 1 }), missingTitle]),
    });
    const result = await fetchItems({ repo, window });
    expect(unwrap(result).map((i) => i.number)).toEqual([1]);
    expect(result.warnings.some((w) => w.includes("skipped 1"))).toBe(true);
  });

  it("honours the page cap", async () => {
    const items = [hit({ isPr: true, n: 1 }), hit({ isPr: true, n: 2 }), hit({ isPr: true, n: 3 })];
    const fetchItems = makeGithubFetchItems({ pageCap: 2, searchIssues: search(items) });
    expect(unwrap(await fetchItems({ repo, window }))).toHaveLength(2);
  });

  it("fails fast with a clear message when the repo precheck reports the repo unreachable", async () => {
    let searched = false;
    const fetchItems = makeGithubFetchItems({
      checkRepo: async () => err(["repo o/r not found or inaccessible — check the org slug"]),
      searchIssues: async () => {
        searched = true;
        return { data: { items: [] } };
      },
    });
    const result = await fetchItems({ repo, window });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result)[0]).toBe("repo o/r not found or inaccessible — check the org slug");
    expect(searched).toBe(false); // precheck short-circuits BEFORE any search call
  });

  it("proceeds to search when the repo precheck passes", async () => {
    const fetchItems = makeGithubFetchItems({
      checkRepo: async () => ok(undefined),
      searchIssues: search([hit({ isPr: true, n: 1 })]),
    });
    expect(unwrap(await fetchItems({ repo, window })).map((i) => i.number)).toEqual([1]);
  });
});
