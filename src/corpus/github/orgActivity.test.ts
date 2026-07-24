import { describe, expect, it } from "vitest";
import type { Repository } from "../../config.js";
import { err, ok } from "../../lib/result.js";
import type { FetchGithubItems } from "./fetch.js";
import { fetchOrgActivity } from "./orgActivity.js";
import type { GithubExportItem } from "./project.js";

const WINDOW = { since: "2026-06-01", until: "2026-07-24" };

function item({ number, tsIso }: { number: number; tsIso: string }): GithubExportItem {
  return {
    kind: "issue",
    number,
    raw: { number },
    title: `#${String(number)}`,
    tsIso,
    url: `https://x/${String(number)}`,
  };
}

/** A fake per-repo fetch that records each call's window + serves seeded items (or an error) per repo. */
function fakeFetch({
  itemsByRepo,
  failRepos = new Set<string>(),
  calls,
}: {
  itemsByRepo: Readonly<Record<string, readonly GithubExportItem[]>>;
  failRepos?: ReadonlySet<string>;
  calls: { repo: string; since: string }[];
}): FetchGithubItems {
  return async ({ repo, window }) => {
    const key = `${repo.owner}/${repo.repo}`;
    calls.push({ repo: key, since: window.since });
    if (failRepos.has(key)) {
      return err([`repo ${key} search failed`]);
    }
    return ok(itemsByRepo[key] ?? []);
  };
}

const REPOS: readonly Repository[] = [
  { owner: "acme", repo: "app" },
  { owner: "acme", repo: "lib" },
];

describe("fetchOrgActivity", () => {
  it("windows each repo from its OWN cursor (a re-run resumes past what it already saw)", async () => {
    const calls: { repo: string; since: string }[] = [];
    await fetchOrgActivity({
      concurrency: 2,
      fetchItems: fakeFetch({ calls, itemsByRepo: {} }),
      ratePerSec: 1000,
      repoCursors: new Map([["acme/app", "2026-07-10T00:00:00.000Z"]]),
      repos: REPOS,
      window: WINDOW,
    });
    expect(calls.find((c) => c.repo === "acme/app")!.since).toBe("2026-07-10");
    expect(calls.find((c) => c.repo === "acme/lib")!.since).toBe("2026-06-01");
  });

  it("combines records + advances each repo to its max tsIso (empty-but-fetched ⇒ `until`)", async () => {
    const result = await fetchOrgActivity({
      concurrency: 2,
      fetchItems: fakeFetch({
        calls: [],
        itemsByRepo: {
          "acme/app": [
            item({ number: 1, tsIso: "2026-07-02T00:00:00.000Z" }),
            item({ number: 2, tsIso: "2026-07-09T00:00:00.000Z" }),
          ],
        },
      }),
      ratePerSec: 1000,
      repoCursors: new Map(),
      repos: REPOS,
      window: WINDOW,
    });
    expect(result.records).toHaveLength(2);
    expect(result.advances).toEqual([
      { cursor: "2026-07-09T00:00:00.000Z", repo: "acme/app" },
      { cursor: "2026-07-24", repo: "acme/lib" },
    ]);
  });

  it("emits a per-repo progress event naming the repo + its record yield", async () => {
    const events: { done: number; total: number; repo: string; recordCount: number }[] = [];
    await fetchOrgActivity({
      concurrency: 1, // serial so the done counter is deterministic
      fetchItems: fakeFetch({
        calls: [],
        itemsByRepo: { "acme/app": [item({ number: 1, tsIso: "2026-07-02T00:00:00.000Z" })] },
      }),
      onProgress: (p) => events.push(p),
      ratePerSec: 1000,
      repoCursors: new Map(),
      repos: REPOS,
      window: WINDOW,
    });
    expect(events).toEqual([
      { done: 1, recordCount: 1, repo: "acme/app", total: 2 },
      { done: 2, recordCount: 0, repo: "acme/lib", total: 2 },
    ]);
  });

  it("isolates one repo's fetch failure as a warning and does NOT advance that repo", async () => {
    const result = await fetchOrgActivity({
      concurrency: 2,
      fetchItems: fakeFetch({
        calls: [],
        failRepos: new Set(["acme/lib"]),
        itemsByRepo: { "acme/app": [item({ number: 1, tsIso: "2026-07-02T00:00:00.000Z" })] },
      }),
      ratePerSec: 1000,
      repoCursors: new Map(),
      repos: REPOS,
      window: WINDOW,
    });
    expect(result.advances.map((a) => a.repo)).toEqual(["acme/app"]);
    expect(result.warnings).toContain("repo acme/lib: repo acme/lib search failed");
  });
});
