import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import type { Embedder } from "./embeddings.js";
import {
  assembleVectorIndex,
  buildVectorIndex,
  type CachedVector,
  cacheRowsForVectors,
  chunkMisses,
  cosine,
  cosineTopN,
  inMemoryVectorCacheStore,
  planVectorBuild,
  recordText,
  shouldCompactCache,
  type VectorIndex,
  vectorContentHash,
} from "./vectorIndex.js";

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "t",
  tsIso: "2024-01-01T00:00:00Z",
  url: "u",
  ...over,
});

describe("recordText / vectorContentHash (lean embed — attrs never embedded)", () => {
  it("embeds title + text only; rich attrs do not change the embedded text", () => {
    const lean = rec({ text: "the body", title: "the title" });
    const rich = rec({ attrs: { labels: ["bug"], state: "open" }, text: "the body", title: "the title" });
    expect(recordText({ record: rich })).toBe(recordText({ record: lean }));
    expect(recordText({ record: rich })).toBe("the title\nthe body");
  });

  it("gives the same content hash whether or not attrs are present (no needless re-embed)", () => {
    const lean = rec({ text: "the body", title: "the title" });
    const rich = rec({ attrs: { state: "open" }, text: "the body", title: "the title" });
    expect(vectorContentHash({ modelId: "m", record: rich })).toBe(vectorContentHash({ modelId: "m", record: lean }));
  });
});

describe("cosine", () => {
  it("is 1 for identical unit vectors, 0 for orthogonal, 0 on length mismatch", () => {
    expect(cosine({ a: Float32Array.from([1, 0]), b: Float32Array.from([1, 0]) })).toBe(1);
    expect(cosine({ a: Float32Array.from([1, 0]), b: Float32Array.from([0, 1]) })).toBe(0);
    expect(cosine({ a: Float32Array.from([1, 0]), b: Float32Array.from([1, 0, 0]) })).toBe(0);
  });
});

describe("cosineTopN", () => {
  it("ranks by similarity to the query vector", () => {
    const index: VectorIndex = { ids: ["#1", "#2"], vectors: [Float32Array.from([1, 0]), Float32Array.from([0, 1])] };
    expect(cosineTopN({ index, limit: 2, queryVector: Float32Array.from([1, 0]) })[0]![0]).toBe("#1");
  });
});

describe("planVectorBuild (pure cache partition)", () => {
  const modelId = "m";
  it("reuses an unchanged record's cached vector and re-embeds a stale/new one", () => {
    const kept = rec({ sourceId: "#1", text: "a" });
    const cached = new Map<string, CachedVector>([
      [
        "#1",
        {
          contentHash: vectorContentHash({ modelId, record: kept }),
          sourceId: "#1",
          vector: Float32Array.from([1, 0]),
        },
      ],
      ["#2", { contentHash: "stale-hash", sourceId: "#2", vector: Float32Array.from([0, 1]) }],
    ]);
    const plan = planVectorBuild({ cached, modelId, records: [kept, rec({ sourceId: "#2", text: "new" })] });
    expect([...plan.reuse.keys()]).toEqual(["#1"]);
    expect(plan.misses.map((m) => m.sourceId)).toEqual(["#2"]);
  });
});

describe("chunkMisses / cacheRowsForVectors / assembleVectorIndex / shouldCompactCache (pure)", () => {
  it("splits misses into fixed-size chunks", () => {
    const misses = [rec({ sourceId: "#1" }), rec({ sourceId: "#2" }), rec({ sourceId: "#3" })];
    expect(chunkMisses({ misses, size: 2 }).map((c) => c.length)).toEqual([2, 1]);
  });

  it("pairs records with vectors into cache rows, dropping a record with no vector", () => {
    const chunk = [rec({ sourceId: "#1" }), rec({ sourceId: "#2" })];
    const hashById = new Map([
      ["#1", "h1"],
      ["#2", "h2"],
    ]);
    const rows = cacheRowsForVectors({ chunk, hashById, vectors: [Float32Array.from([1, 0])] });
    expect(rows.map((r) => r.sourceId)).toEqual(["#1"]); // #2 had no vector → dropped
    expect(rows[0]!.contentHash).toBe("h1");
  });

  it("assembles the index in record order from fresh + reused vectors", () => {
    const records = [rec({ sourceId: "#1" }), rec({ sourceId: "#2" }), rec({ sourceId: "#3" })];
    const index = assembleVectorIndex({
      fresh: new Map([["#2", Float32Array.from([0, 1])]]),
      records,
      reuse: new Map([["#1", Float32Array.from([1, 0])]]),
    });
    expect(index.ids).toEqual(["#1", "#2"]); // #3 has no vector anywhere → omitted, order preserved
  });

  it("compacts only when fresh work happened or the row set changed size", () => {
    expect(shouldCompactCache({ cachedSize: 5, freshCount: 1, indexSize: 5 })).toBe(true); // fresh work
    expect(shouldCompactCache({ cachedSize: 4, freshCount: 0, indexSize: 5 })).toBe(true); // grew
    expect(shouldCompactCache({ cachedSize: 5, freshCount: 0, indexSize: 5 })).toBe(false); // pure cache-hit run
  });
});

describe("buildVectorIndex", () => {
  it("embeds misses once and reuses the cache on the next build", async () => {
    let calls = 0;
    const embedder: Embedder = {
      embedDocuments: async (texts) => {
        calls += 1;
        return texts.map(() => Float32Array.from([1, 0]));
      },
      embedQuery: async (texts) => texts.map(() => Float32Array.from([1, 0])),
      modelId: "c",
    };
    const store = inMemoryVectorCacheStore();
    const records = [rec({ sourceId: "#1", text: "a" }), rec({ sourceId: "#2", text: "b" })];
    const first = await buildVectorIndex({ embedder, persist: true, records, store });
    expect(first.ids).toEqual(["#1", "#2"]);
    expect(calls).toBe(1);
    await buildVectorIndex({ embedder, records, store });
    expect(calls).toBe(1); // reused from cache, no re-embed
  });
});

/** An embedder that counts calls and records every text it embeds. */
function countingEmbedder(): { embedder: Embedder; calls: () => number; seen: string[] } {
  let calls = 0;
  const seen: string[] = [];
  return {
    calls: () => calls,
    embedder: {
      embedDocuments: async (texts) => {
        calls += 1;
        seen.push(...texts);
        return texts.map(() => Float32Array.from([1, 0]));
      },
      embedQuery: async (texts) => texts.map(() => Float32Array.from([1, 0])),
      modelId: "c",
    },
    seen,
  };
}

describe("buildVectorIndex resumability", () => {
  const records = [rec({ sourceId: "#1", text: "a" }), rec({ sourceId: "#2", text: "b" })];

  it("flushes fresh vectors to the cache (append) so a killed run leaves them durable", async () => {
    const { embedder } = countingEmbedder();
    const store = inMemoryVectorCacheStore();
    await buildVectorIndex({ embedder, persist: true, records, store });
    const persisted = await store.load();
    expect(persisted.map((v) => v.sourceId).toSorted()).toEqual(["#1", "#2"]);
  });

  it("resumes after a kill: a new store seeded from the flushed rows re-embeds nothing", async () => {
    const first = countingEmbedder();
    const storeA = inMemoryVectorCacheStore();
    await buildVectorIndex({ embedder: first.embedder, persist: true, records, store: storeA });
    const survived = await storeA.load(); // the rows that were flushed before the "kill"
    const storeB = inMemoryVectorCacheStore({ seed: survived });
    const second = countingEmbedder();
    await buildVectorIndex({ embedder: second.embedder, persist: true, records, store: storeB });
    expect(second.calls()).toBe(0); // everything resumed from the flushed cache
  });

  it("re-embeds only the records missing from the cache (incremental)", async () => {
    const store = inMemoryVectorCacheStore();
    const first = countingEmbedder();
    await buildVectorIndex({ embedder: first.embedder, persist: true, records: [records[0]!], store });
    const second = countingEmbedder();
    await buildVectorIndex({ embedder: second.embedder, persist: true, records, store });
    expect(second.seen).toEqual(["b"]); // only the newly-added record is embedded
  });

  it("emits embed progress with done/total", async () => {
    const events: { done: number; total: number }[] = [];
    const { embedder } = countingEmbedder();
    await buildVectorIndex({
      embedder,
      onProgress: (p) => events.push(p),
      persist: true,
      records: [records[0]!],
      store: inMemoryVectorCacheStore(),
    });
    expect(events).toEqual([{ done: 1, total: 1 }]);
  });
});
