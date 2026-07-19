import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bronzeFile, distilCachePath, goldDir, silverIndexDir } from "../../../corpus/corpusPaths.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import type { LlmClient } from "../../../llm/provider.js";
import { runDerive } from "../derive/run.js";
import { runDistilWithDeps } from "./run.js";

/** A fake LLM that always returns a valid, cited digest — so distil succeeds without spawning `claude`. */
const fakeLlm: LlmClient = {
  complete: async () => ({
    content: [
      {
        input: { points: [{ citations: ["cite://decision"], point: "a decision was made" }], summary: "a digest" },
        type: "tool_use",
      },
    ],
  }),
};

/** A fake LLM whose transport always throws — every batch fails (skipped stays 0, digests come up short). */
const throwingLlm: LlmClient = {
  complete: async () => {
    throw new Error("claude CLI timed out");
  },
};

const window = { since: "2026-01-01", until: "2026-02-01" };

const record = (over: Partial<CorpusRecord>): CorpusRecord => ({
  container: "acme/web",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "shipped the retriever",
  tsIso: "2026-01-05T00:00:00Z",
  url: "https://example.test/1",
  ...over,
});

/** Two records in DIFFERENT containers ⇒ two distil batches (so --max-batches 1 defers one). */
const records: readonly CorpusRecord[] = [
  record({ container: "acme/web", sourceId: "#1" }),
  record({ container: "acme/api", sourceId: "#2", text: "fixed the auth token bug" }),
];

/** Seed a temp home's bronze with the records + derive silver, so distil has an index to build gold from. */
function seedHome(): string {
  const home = mkdtempSync(join(tmpdir(), "slopweaver-distil-"));
  const file = bronzeFile({ home, source: "github", window });
  mkdirSync(join(home, "corpus", "bronze", "github"), { recursive: true });
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join("\n"), "utf8");
  runDerive(["x", "y", "derive", "--home", home]);
  return home;
}

const homes: string[] = [];
const freshHome = (): string => {
  const home = seedHome();
  homes.push(home);
  return home;
};

afterEach(() => {
  // temp dirs are under the OS tmpdir; leaving them is harmless, but drop references
  homes.length = 0;
});

const goldFiles = ({ home }: { home: string }): boolean => existsSync(join(goldDir({ home }), "overview.md"));

describe("runDistilWithDeps partial-output guard", () => {
  it("a capped run (skipped>0) saves the cache but does NOT write gold", async () => {
    const home = freshHome();
    const code = await runDistilWithDeps({
      argv: ["x", "y", "distil", "--home", home, "--max-batches", "1"],
      client: fakeLlm,
    });
    expect(code).toBe(0);
    expect(goldFiles({ home })).toBe(false); // partial ⇒ gold not written
    // the one completed batch WAS cached (the resume unit)
    const cache = JSON.parse(readFileSync(distilCachePath({ home }), "utf8")) as Record<string, unknown>;
    expect(Object.keys(cache)).toHaveLength(1);
  });

  it("resumes: an uncapped re-run reuses the cached batch and writes complete gold", async () => {
    const home = freshHome();
    await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home, "--max-batches", "1"], client: fakeLlm });
    const code = await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home], client: fakeLlm });
    expect(code).toBe(0);
    expect(goldFiles({ home })).toBe(true);
    // both source containers made it into the by-source gold (nothing lost across the resume)
    const bySource = readFileSync(join(goldDir({ home }), "by-source", "github.md"), "utf8");
    expect(bySource).toContain("acme/web");
    expect(bySource).toContain("acme/api");
  });

  it("a later capped run does NOT rewrite complete gold (guard protects the last complete build)", async () => {
    const home = freshHome();
    await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home], client: fakeLlm }); // full build
    const before = readFileSync(join(goldDir({ home }), "overview.md"), "utf8");
    // Force a fresh miss by clearing the cache, then cap: 1 call + 1 deferred ⇒ guard trips.
    writeFileSync(distilCachePath({ home }), "{}", "utf8");
    await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home, "--max-batches", "1"], client: fakeLlm });
    expect(readFileSync(join(goldDir({ home }), "overview.md"), "utf8")).toBe(before); // unchanged
  });

  it("a FAILED batch (not deferred) also withholds gold — the guard covers the failure path too", async () => {
    const home = freshHome();
    await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home], client: fakeLlm }); // complete build
    const before = readFileSync(join(goldDir({ home }), "overview.md"), "utf8");
    // Clear the cache so every batch is a miss, then distil with a transport that always throws: skipped
    // stays 0 but the digest set is incomplete ⇒ the guard must NOT rewrite the last complete gold.
    writeFileSync(distilCachePath({ home }), "{}", "utf8");
    const code = await runDistilWithDeps({ argv: ["x", "y", "distil", "--home", home], client: throwingLlm });
    expect(code).toBe(0);
    expect(readFileSync(join(goldDir({ home }), "overview.md"), "utf8")).toBe(before); // unchanged
  });

  it("the silver index derive produced is what gold reads (no re-derive needed)", () => {
    const home = freshHome();
    const directory = JSON.parse(readFileSync(join(silverIndexDir({ home }), "directory.json"), "utf8")) as {
      containers: unknown[];
    };
    expect(directory.containers.length).toBeGreaterThan(0);
  });
});
