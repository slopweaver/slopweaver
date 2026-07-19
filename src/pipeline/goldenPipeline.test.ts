/**
 * The golden bronze → silver → gold end-to-end test — the confidence net unit tests can't give. A small
 * synthetic (redaction-free, identifier-free) corpus is written to a temp home, then run through the REAL
 * verbs (derive + distil, with a FAKE LLM) and the REAL embed path (with the fake concept embedder), and
 * the whole tier output is asserted exactly: bronze counts + raw retention, silver directory/graph/
 * opportunity counts, gold docs + citation survival, gold read back as records, the partial-output guard,
 * and a killed-then-resumed embed that re-embeds nothing.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runDerive } from "../cli/commands/derive/run.js";
import { runDistilWithDeps } from "../cli/commands/distil/run.js";
import { bronzeFile, goldDir, silverIdentitiesPath, silverIndexDir } from "../corpus/corpusPaths.js";
import { readCorpusDir } from "../corpus/corpusStore.js";
import type { CorpusRecord } from "../corpus/types.js";
import type { LlmClient } from "../llm/provider.js";
import type { Embedder } from "../retrieval/embeddings.js";
import { fakeConceptEmbedder } from "../retrieval/fakeEmbedder.js";
import { readGoldRecords } from "../retrieval/goldRecords.js";
import { buildVectorIndex, inMemoryVectorCacheStore } from "../retrieval/vectorIndex.js";
import { deriveSilver } from "../silver/derive.js";
import { stateHomePaths } from "../stateHome.js";

const window = { since: "2026-01-01", until: "2026-02-01" };

/**
 * A synthetic corpus: two github containers (a web + an api repo) that cross-reference each other, and a
 * slack channel — all with authors, urls (citations), and one record carrying a `raw` payload.
 */
const CORPUS: readonly CorpusRecord[] = [
  {
    author: "ada",
    container: "acme/web",
    kind: "pr",
    raw: { merged: true, number: 1 },
    refs: ["#9"],
    source: "github",
    sourceId: "acme/web#1",
    text: "wire the retriever to the new api endpoint",
    title: "retriever wiring",
    tsIso: "2026-01-10T00:00:00Z",
    url: "https://example.test/web/1",
  },
  {
    author: "grace",
    container: "acme/web",
    kind: "issue",
    refs: [],
    source: "github",
    sourceId: "acme/web#2",
    text: "recall regression after the last deploy",
    title: "recall regression",
    tsIso: "2026-01-11T00:00:00Z",
    url: "https://example.test/web/2",
  },
  {
    author: "ada",
    container: "acme/api",
    kind: "pr",
    refs: ["#1"],
    source: "github",
    sourceId: "acme/api#9",
    text: "add the ranking endpoint the web retriever calls",
    title: "ranking endpoint",
    tsIso: "2026-01-09T00:00:00Z",
    url: "https://example.test/api/9",
  },
  {
    author: "grace",
    container: "general",
    kind: "message",
    refs: [],
    source: "slack",
    sourceId: "slack-1",
    text: "the auth token refresh is failing intermittently",
    tsIso: "2026-01-12T00:00:00Z",
    url: "https://example.test/slack/1",
  },
];

/** A fake LLM: a valid, cited digest per batch (so distil runs without spawning `claude`). */
const fakeLlm: LlmClient = {
  complete: async () => ({
    content: [
      {
        input: { points: [{ citations: ["cite://grounded"], point: "a concrete decision" }], summary: "a digest" },
        type: "tool_use",
      },
    ],
  }),
};

/** Write the corpus to a fresh temp home's bronze. */
function seedBronze(): string {
  const home = mkdtempSync(join(tmpdir(), "slopweaver-golden-"));
  mkdirSync(join(home, "corpus", "bronze", "github"), { recursive: true });
  mkdirSync(join(home, "corpus", "bronze", "slack"), { recursive: true });
  const bySource = new Map<string, CorpusRecord[]>();
  for (const r of CORPUS) {
    bySource.set(r.source, [...(bySource.get(r.source) ?? []), r]);
  }
  for (const [source, recs] of bySource) {
    writeFileSync(
      bronzeFile({ home, source: source as CorpusRecord["source"], window }),
      recs.map((r) => JSON.stringify(r)).join("\n"),
      "utf8",
    );
  }
  return home;
}

describe("golden pipeline: bronze retention", () => {
  it("reads back EXACTLY the seeded records, preserving the raw payload", () => {
    const home = seedBronze();
    const read = readCorpusDir({ dir: join(home, "corpus", "bronze") });
    expect(read.ok).toBe(true);
    const records = read.ok ? read.value : [];
    expect(records).toHaveLength(4);
    const withRaw = records.find((r) => r.sourceId === "acme/web#1")!;
    expect(withRaw.raw).toEqual({ merged: true, number: 1 }); // full raw payload retained
  });
});

describe("golden pipeline: silver derivation (exact counts)", () => {
  it("builds the directory, cross-ref graph, and opportunities deterministically", () => {
    const artifacts = deriveSilver({ identityMap: new Map(), records: CORPUS });
    expect(artifacts.directory.people.map((p) => p.id).toSorted()).toEqual(["ada", "grace"]);
    expect(artifacts.directory.containers.map((c) => c.id).toSorted()).toEqual(["acme/api", "acme/web", "general"]);
    expect(artifacts.graph.nodes).toHaveLength(4);
    // acme/web#1 (refs #9) ↔ acme/api#9 (refs #1, sourceId mines both) share entity tokens ⇒ one edge.
    expect(artifacts.graph.edges).toHaveLength(1);
    const edge = artifacts.graph.edges[0]!;
    expect([edge.a, edge.b].toSorted()).toEqual(["github:acme/api#9", "github:acme/web#1"]);
    // This deterministic corpus spots no opportunities (the heuristic needs stronger co-occurrence) — pin it.
    expect(artifacts.opportunities).toHaveLength(0);
  });
});

describe("golden pipeline: gold synthesis + read-back", () => {
  it("distils to gold, survives citations, and reads gold back as records", async () => {
    const home = seedBronze();
    runDerive(["x", "y", "derive", "--home", home]);
    const code = await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home], client: fakeLlm });
    expect(code).toBe(0);

    // gold docs exist: overview + per-source + where-to-look
    expect(existsSync(join(goldDir({ home }), "overview.md"))).toBe(true);
    expect(existsSync(join(goldDir({ home }), "by-source", "github.md"))).toBe(true);
    expect(existsSync(join(goldDir({ home }), "by-source", "slack.md"))).toBe(true);

    // the LLM's citations survive into the gold markdown
    const github = readFileSync(join(goldDir({ home }), "by-source", "github.md"), "utf8");
    expect(github).toContain("cite://grounded");

    // gold reads back as retrievable corpus records (synthetic `gold` source, `finding` kind)
    const goldRecords = readGoldRecords({ home, tsIso: "2026-07-19T00:00:00Z" });
    expect(goldRecords.length).toBeGreaterThan(0);
    expect(goldRecords.every((r) => r.source === "gold" && r.kind === "finding")).toBe(true);
  });

  it("the partial-output guard leaves complete gold untouched on a later capped run", async () => {
    const home = seedBronze();
    runDerive(["x", "y", "derive", "--home", home]);
    await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home], client: fakeLlm });
    const overviewBefore = readFileSync(join(goldDir({ home }), "overview.md"), "utf8");
    // clear the cache and cap so the run defers ⇒ guard must not rewrite gold
    writeFileSync(join(home, "corpus", ".cache", "distil", "batches.json"), "{}", "utf8");
    await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home, "--max-batches", "1"], client: fakeLlm });
    expect(readFileSync(join(goldDir({ home }), "overview.md"), "utf8")).toBe(overviewBefore);
  });
});

describe("golden pipeline: cross-source identity map", () => {
  /** Four sources, one human (`ada` / `U1` / `Ada Lovelace` / `ada-notion`), seeded via the roster. */
  const MULTI: readonly CorpusRecord[] = [
    {
      author: "ada",
      container: "acme/web",
      kind: "pr",
      refs: [],
      source: "github",
      sourceId: "gh1",
      text: "pr",
      tsIso: "2026-01-10T00:00:00Z",
      url: "https://example.test/1",
    },
    {
      author: "U1",
      container: "slack/c",
      kind: "message",
      refs: [],
      source: "slack",
      sourceId: "s1",
      text: "msg",
      tsIso: "2026-01-11T00:00:00Z",
      url: "https://example.test/2",
    },
    {
      author: "Ada Lovelace",
      container: "T-1",
      kind: "issue",
      refs: [],
      source: "linear",
      sourceId: "l1",
      text: "issue",
      tsIso: "2026-01-12T00:00:00Z",
      url: "https://example.test/3",
    },
    {
      author: "ada-notion",
      container: "db1",
      kind: "page",
      refs: [],
      source: "notion",
      sourceId: "n1",
      text: "page",
      tsIso: "2026-01-13T00:00:00Z",
      url: "https://example.test/4",
    },
  ];

  const ROSTER = JSON.stringify([
    {
      handle: "ada",
      id: "person:ada",
      identities: [
        { nativeId: "ada", source: "github" },
        { nativeId: "U1", source: "slack" },
        { nativeId: "Ada Lovelace", source: "linear" },
        { nativeId: "ada-notion", source: "notion" },
      ],
      name: "Ada Lovelace",
    },
  ]);

  function seedMulti(): string {
    const home = mkdtempSync(join(tmpdir(), "slopweaver-identity-"));
    for (const record of MULTI) {
      mkdirSync(join(home, "corpus", "bronze", record.source), { recursive: true });
      writeFileSync(bronzeFile({ home, source: record.source, window }), JSON.stringify(record), "utf8");
    }
    writeFileSync(stateHomePaths({ home }).identityJson, ROSTER, "utf8");
    return home;
  }

  it("collapses four per-source dupes into one canonical person in directory + derived identities", () => {
    const home = seedMulti();
    runDerive(["x", "y", "derive", "--home", home]);

    const directory = JSON.parse(readFileSync(join(silverIndexDir({ home }), "directory.json"), "utf8")) as {
      people: { id: string; sources: string[]; confidence?: string }[];
    };
    expect(directory.people).toHaveLength(1);
    expect(directory.people[0]!.id).toBe("person:ada");
    expect(directory.people[0]!.sources).toEqual(["github", "linear", "notion", "slack"]);
    expect(directory.people[0]!.confidence).toBe("override");

    const identities = JSON.parse(readFileSync(silverIdentitiesPath({ home }), "utf8")) as {
      people: { id: string; identities: unknown[] }[];
    };
    expect(identities.people.map((p) => p.id)).toEqual(["person:ada"]);
    expect(identities.people[0]!.identities).toHaveLength(4);
  });
});

describe("golden pipeline: embed resume (no re-embed)", () => {
  /** A concept embedder that counts how many document batches it embeds. */
  function countingEmbedder(): { embedder: Embedder; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      embedder: {
        embedDocuments: async (texts) => {
          calls += 1;
          return fakeConceptEmbedder.embedDocuments(texts);
        },
        embedQuery: (texts) => fakeConceptEmbedder.embedQuery(texts),
        modelId: fakeConceptEmbedder.modelId,
      },
    };
  }

  it("resumes from the flushed vector cache and re-embeds nothing on the second build", async () => {
    const first = countingEmbedder();
    const store = inMemoryVectorCacheStore();
    const firstIndex = await buildVectorIndex({ embedder: first.embedder, persist: true, records: CORPUS, store });
    expect(firstIndex.ids).toHaveLength(4);
    expect(first.calls()).toBeGreaterThan(0);

    // resume: a new store seeded from the flushed rows re-embeds nothing
    const survived = await store.load();
    const second = countingEmbedder();
    await buildVectorIndex({
      embedder: second.embedder,
      persist: true,
      records: CORPUS,
      store: inMemoryVectorCacheStore({ seed: survived }),
    });
    expect(second.calls()).toBe(0);
  });
});
