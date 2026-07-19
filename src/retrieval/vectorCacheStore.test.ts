import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EMBEDDING_DIM } from "./embeddings.js";
import { diskVectorCacheStore, parseVectorCacheLine, serialiseVectorRow } from "./vectorCacheStore.js";
import type { CachedVector } from "./vectorIndex.js";

describe("parseVectorCacheLine", () => {
  const goodVector = Array.from({ length: EMBEDDING_DIM }, () => 0.1);

  it("parses a well-formed row", () => {
    const line = JSON.stringify({ contentHash: "h", sourceId: "s", vector: goodVector });
    const parsed = parseVectorCacheLine({ line });
    expect(parsed!.sourceId).toBe("s");
    expect(parsed!.vector.length).toBe(EMBEDDING_DIM);
  });

  it("returns undefined for a blank line", () => {
    expect(parseVectorCacheLine({ line: "   " })).toBeUndefined();
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseVectorCacheLine({ line: "{bad" })).toBeUndefined();
  });

  it("returns undefined for a wrong-dimension vector", () => {
    const line = JSON.stringify({ contentHash: "h", sourceId: "s", vector: [0.1, 0.2] });
    expect(parseVectorCacheLine({ line })).toBeUndefined();
  });

  it("returns undefined when a required field is missing", () => {
    const line = JSON.stringify({ sourceId: "s", vector: goodVector });
    expect(parseVectorCacheLine({ line })).toBeUndefined();
  });
});

describe("serialiseVectorRow", () => {
  it("serialises a vector to a JSON object string with the array form", () => {
    const vector: CachedVector = { contentHash: "h", sourceId: "s", vector: Float32Array.from([1, 2]) };
    expect(serialiseVectorRow({ vector })).toBe('{"contentHash":"h","sourceId":"s","vector":[1,2]}');
  });
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "slop-vec-"));
});
afterEach(() => {
  rmSync(dir, { force: true, recursive: true });
});

const good: CachedVector = { contentHash: "h", sourceId: "#1", vector: new Float32Array(EMBEDDING_DIM).fill(0.1) };
const wrongDim: CachedVector = { contentHash: "h", sourceId: "#2", vector: Float32Array.from([1, 0]) };
const vec = ({ sourceId, hash }: { sourceId: string; hash: string }): CachedVector => ({
  contentHash: hash,
  sourceId,
  vector: new Float32Array(EMBEDDING_DIM).fill(0.2),
});

describe("diskVectorCacheStore", () => {
  it("round-trips a full-dimension vector", async () => {
    const store = diskVectorCacheStore({ cacheDir: dir });
    await store.save([good]);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.vector).toHaveLength(EMBEDDING_DIM);
  });

  it("drops wrong-dimension rows on load", async () => {
    const store = diskVectorCacheStore({ cacheDir: dir });
    await store.save([good, wrongDim]);
    expect((await store.load()).map((v) => v.sourceId)).toEqual(["#1"]);
  });

  it("appends chunks without truncating — both survive a reload (resumability)", async () => {
    const store = diskVectorCacheStore({ cacheDir: dir });
    await store.append([vec({ hash: "h1", sourceId: "#1" })]);
    await store.append([vec({ hash: "h2", sourceId: "#2" })]);
    expect((await store.load()).map((v) => v.sourceId)).toEqual(["#1", "#2"]);
  });

  it("keeps stale rows in file order so the latest-appended row wins on dedup by caller", async () => {
    const store = diskVectorCacheStore({ cacheDir: dir });
    await store.append([vec({ hash: "old", sourceId: "#1" })]);
    await store.append([vec({ hash: "new", sourceId: "#1" })]);
    const loaded = await store.load();
    expect(loaded.map((v) => v.contentHash)).toEqual(["old", "new"]); // caller keeps the last (newest)
  });

  it("append is a no-op for an empty chunk", async () => {
    const store = diskVectorCacheStore({ cacheDir: dir });
    await store.append([]);
    expect(await store.load()).toEqual([]);
  });

  it("compacts atomically: exact final content and no leftover temp file", async () => {
    const store = diskVectorCacheStore({ cacheDir: dir });
    await store.append([vec({ hash: "stale", sourceId: "#1" })]); // a row a later compaction should replace
    await store.save([vec({ hash: "h", sourceId: "#1" }), vec({ hash: "h", sourceId: "#2" })]);
    expect((await store.load()).map((v) => v.sourceId)).toEqual(["#1", "#2"]);
    expect(existsSync(join(dir, "vectors.jsonl.tmp"))).toBe(false); // temp renamed away, no partial state
  });
});
