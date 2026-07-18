/**
 * The in-memory vector index and its cache contract. Pure (the embedder + store are injected). The
 * cache key is BOTH `sourceId` AND a content hash, so an unchanged record reuses its vector, an edited
 * record re-embeds, and a model/char-cap change invalidates everything. `cosine` is a dot product of
 * unit vectors (the embedder L2-normalises), so a length mismatch degrades to 0 rather than NaN.
 */
import { createHash } from "node:crypto";

import type { CorpusRecord } from "../corpus/types.js";
import { type Embedder, MAX_EMBED_CHARS } from "./embeddings.js";

export interface CachedVector {
  readonly sourceId: string;
  readonly contentHash: string;
  readonly vector: Float32Array;
}

export interface VectorCacheStore {
  load(): Promise<readonly CachedVector[]>;
  save(vectors: readonly CachedVector[]): Promise<void>;
}

export interface VectorIndex {
  readonly ids: readonly string[];
  readonly vectors: readonly Float32Array[];
}

/** The text that gets embedded for a record (title-led, so a title-targeted query ranks). */
export function recordText({ record }: { record: CorpusRecord }): string {
  return record.title !== undefined && record.title.length > 0 ? `${record.title}\n${record.text}` : record.text;
}

/** Content hash for a record's vector — invalidates on text/model/char-cap change. */
export function vectorContentHash({ modelId, record }: { modelId: string; record: CorpusRecord }): string {
  return createHash("sha256")
    .update(`${modelId}\0${String(MAX_EMBED_CHARS)} ${recordText({ record })}`)
    .digest("hex");
}

/**
 * Build the vector index, embedding only records whose cached hash is missing or stale.
 *
 * @param records the corpus records
 * @param embedder the document embedder
 * @param store the vector cache
 * @param persist when true, write the (full) cache back — use only on a full-corpus build, since save overwrites
 * @returns the in-memory index (records whose embed failed are omitted)
 */
export async function buildVectorIndex({
  records,
  embedder,
  store,
  persist = false,
}: {
  records: readonly CorpusRecord[];
  embedder: Embedder;
  store: VectorCacheStore;
  persist?: boolean;
}): Promise<VectorIndex> {
  const cached = new Map<string, CachedVector>();
  for (const entry of await store.load()) {
    cached.set(entry.sourceId, entry);
  }
  const hashById = new Map<string, string>();
  const reuse = new Map<string, Float32Array>();
  const misses: CorpusRecord[] = [];
  for (const record of records) {
    const hash = vectorContentHash({ modelId: embedder.modelId, record });
    hashById.set(record.sourceId, hash);
    const hit = cached.get(record.sourceId);
    if (hit?.contentHash === hash) {
      reuse.set(record.sourceId, hit.vector);
    } else {
      misses.push(record);
    }
  }

  const fresh = new Map<string, Float32Array>();
  if (misses.length > 0) {
    const vectors = await embedder.embedDocuments(misses.map((record) => recordText({ record })));
    misses.forEach((record, i) => {
      const vector = vectors[i];
      if (vector !== undefined) {
        fresh.set(record.sourceId, vector);
      }
    });
  }

  const ids: string[] = [];
  const vectors: Float32Array[] = [];
  for (const record of records) {
    const vector = fresh.get(record.sourceId) ?? reuse.get(record.sourceId);
    if (vector !== undefined) {
      ids.push(record.sourceId);
      vectors.push(vector);
    }
  }

  if (persist && (fresh.size > 0 || ids.length !== cached.size)) {
    await store.save(
      ids.map((id, i) => ({
        contentHash: hashById.get(id)!, // every id came from `records`, all of which are in hashById
        sourceId: id,
        vector: vectors[i] ?? new Float32Array(),
      })),
    );
  }
  return { ids, vectors };
}

/** Cosine similarity of two unit vectors (dot product); 0 on length mismatch. */
export function cosine({ a, b }: { a: Float32Array; b: Float32Array }): number {
  if (a.length !== b.length) {
    return 0;
  }
  let dot = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/**
 * Top-N by cosine similarity to a query vector.
 *
 * @param index the vector index
 * @param queryVector the query's unit vector
 * @param limit max results (non-positive ⇒ `[]`)
 * @returns `[sourceId, score]` pairs, score desc, ties by id asc
 */
export function cosineTopN({
  index,
  queryVector,
  limit,
}: {
  index: VectorIndex;
  queryVector: Float32Array;
  limit: number;
}): readonly (readonly [string, number])[] {
  if (limit <= 0) {
    return [];
  }
  const scored = index.ids.map((id, i): readonly [string, number] => [
    id,
    cosine({ a: queryVector, b: index.vectors[i] ?? new Float32Array() }),
  ]);
  scored.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return scored.slice(0, limit);
}

/** An in-memory vector cache for tests. */
export function inMemoryVectorCacheStore({ seed = [] }: { seed?: readonly CachedVector[] } = {}): VectorCacheStore {
  let stored: readonly CachedVector[] = seed;
  return {
    load: async () => stored,
    save: async (vectors) => {
      stored = vectors;
    },
  };
}
