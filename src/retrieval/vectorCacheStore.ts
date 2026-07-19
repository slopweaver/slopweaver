/**
 * On-disk vector cache — NDJSON (`vectors.jsonl`), one `{sourceId, contentHash, vector}` per line. NDJSON
 * deliberately, NOT one big JSON array: at scale a single `JSON.stringify`/`readFileSync` of the whole
 * corpus's vectors crosses V8's ~512MB max-string limit and throws, which would silently and permanently
 * degrade semantic search to BM25. Wrong-dimension rows are dropped on load (re-embedded), never used.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { parseJsonLine } from "../lib/jsonParse.js";
import { isRecord } from "../lib/parsers.js";
import { orThrow, safeFs } from "../lib/safeBoundary.js";
import { EMBEDDING_DIM } from "./embeddings.js";
import type { CachedVector, VectorCacheStore } from "./vectorIndex.js";

export const VECTOR_CACHE_FILE = "vectors.jsonl";
const SAVE_BATCH_ROWS = 5000;

/**
 * Parse one NDJSON line into a `CachedVector`, or undefined (blank/corrupt/wrong-dim). Pure — the tolerant
 * parse is {@link parseJsonLine}; the row-shape + embedding-dimension checks stay local.
 *
 * @param line the raw NDJSON line
 * @returns the cached vector, or undefined when unusable
 */
export function parseVectorCacheLine({ line }: { line: string }): CachedVector | undefined {
  const parsed = parseJsonLine({ line });
  if (parsed.isErr()) {
    return undefined;
  }
  const value = parsed.value;
  if (
    !isRecord(value) ||
    typeof value["sourceId"] !== "string" ||
    typeof value["contentHash"] !== "string" ||
    !Array.isArray(value["vector"])
  ) {
    return undefined;
  }
  if (value["vector"].length !== EMBEDDING_DIM || !value["vector"].every((n): n is number => typeof n === "number")) {
    return undefined;
  }
  return {
    contentHash: value["contentHash"],
    sourceId: value["sourceId"],
    vector: Float32Array.from(value["vector"]),
  };
}

/** Serialise one vector to its NDJSON object string. Pure. */
export function serialiseVectorRow({ vector }: { vector: CachedVector }): string {
  return JSON.stringify({
    contentHash: vector.contentHash,
    sourceId: vector.sourceId,
    vector: Array.from(vector.vector),
  });
}

/** Serialise vectors to NDJSON rows (one JSON object per line, no trailing newline). Pure. */
export function toRows({ vectors }: { vectors: readonly CachedVector[] }): string {
  return vectors.map((v) => serialiseVectorRow({ vector: v })).join("\n");
}

/** Append rows durably (safeFs typed error, re-thrown): a kill leaves the already-flushed rows intact. */
function appendVectorRows({
  cacheDir,
  path,
  vectors,
}: {
  cacheDir: string;
  path: string;
  vectors: readonly CachedVector[];
}): void {
  if (vectors.length === 0) {
    return;
  }
  orThrow({
    result: safeFs({
      execute: () => {
        mkdirSync(cacheDir, { recursive: true });
        appendFileSync(path, `${toRows({ vectors })}\n`, "utf8");
      },
      operation: "vectorCache.append",
      path,
    }),
  });
}

/** Load + parse every row; a missing/unreadable cache ⇒ empty (re-embed), never fatal. */
function loadVectorRows({ path }: { path: string }): CachedVector[] {
  const read = safeFs({ execute: () => readFileSync(path, "utf8"), operation: "vectorCache.load", path });
  if (read.isErr()) {
    return [];
  }
  const vectors: CachedVector[] = [];
  for (const line of read.value.split("\n")) {
    const parsed = parseVectorCacheLine({ line });
    if (parsed !== undefined) {
      vectors.push(parsed);
    }
  }
  return vectors;
}

/**
 * ATOMIC compaction: build the whole file at a temp path (batched, so a huge corpus never crosses V8's
 * max-string limit), then rename over the target. A kill mid-write can only leave the discardable temp file
 * — never a truncated cache. The whole sequence goes through safeFs (typed io error) and re-throws.
 */
function saveVectorRows({
  cacheDir,
  path,
  vectors,
}: {
  cacheDir: string;
  path: string;
  vectors: readonly CachedVector[];
}): void {
  orThrow({
    result: safeFs({
      execute: () => {
        mkdirSync(cacheDir, { recursive: true });
        const tmp = `${path}.tmp`;
        writeFileSync(tmp, "", "utf8");
        for (let i = 0; i < vectors.length; i += SAVE_BATCH_ROWS) {
          const rows = toRows({ vectors: vectors.slice(i, i + SAVE_BATCH_ROWS) });
          appendFileSync(tmp, rows.length > 0 ? `${rows}\n` : "", "utf8");
        }
        renameSync(tmp, path);
      },
      operation: "vectorCache.save",
      path,
    }),
  });
}

/**
 * A disk-backed vector cache at `<cacheDir>/vectors.jsonl` — a thin shell over the pure serialise/parse
 * cores + the effectful append/load/save fs edges.
 *
 * @param cacheDir the `.cache` directory
 * @returns the vector cache store
 */
export function diskVectorCacheStore({ cacheDir }: { cacheDir: string }): VectorCacheStore {
  const path = join(cacheDir, VECTOR_CACHE_FILE);
  return {
    append: async (vectors) => {
      appendVectorRows({ cacheDir, path, vectors });
    },
    load: async () => loadVectorRows({ path }),
    save: async (vectors) => {
      saveVectorRows({ cacheDir, path, vectors });
    },
  };
}
