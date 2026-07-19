/**
 * On-disk vector cache — NDJSON (`vectors.jsonl`), one `{sourceId, contentHash, vector}` per line. NDJSON
 * deliberately, NOT one big JSON array: at scale a single `JSON.stringify`/`readFileSync` of the whole
 * corpus's vectors crosses V8's ~512MB max-string limit and throws, which would silently and permanently
 * degrade semantic search to BM25. Wrong-dimension rows are dropped on load (re-embedded), never used.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { isRecord } from "../lib/parsers.js";
import { orThrow, safeFs } from "../lib/safeBoundary.js";
import { EMBEDDING_DIM } from "./embeddings.js";
import type { CachedVector, VectorCacheStore } from "./vectorIndex.js";

export const VECTOR_CACHE_FILE = "vectors.jsonl";
const SAVE_BATCH_ROWS = 5000;

/** Parse one NDJSON line into a `CachedVector`, or undefined (blank/corrupt/wrong-dim). */
function parseLine({ line }: { line: string }): CachedVector | undefined {
  if (line.trim().length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed["sourceId"] !== "string" ||
    typeof parsed["contentHash"] !== "string" ||
    !Array.isArray(parsed["vector"])
  ) {
    return undefined;
  }
  if (parsed["vector"].length !== EMBEDDING_DIM || !parsed["vector"].every((n): n is number => typeof n === "number")) {
    return undefined;
  }
  return {
    contentHash: parsed["contentHash"],
    sourceId: parsed["sourceId"],
    vector: Float32Array.from(parsed["vector"]),
  };
}

/** Serialise vectors to NDJSON rows (one JSON object per line, no trailing newline). */
function toRows({ vectors }: { vectors: readonly CachedVector[] }): string {
  return vectors
    .map((v) => JSON.stringify({ contentHash: v.contentHash, sourceId: v.sourceId, vector: Array.from(v.vector) }))
    .join("\n");
}

/**
 * A disk-backed vector cache at `<cacheDir>/vectors.jsonl`.
 *
 * @param cacheDir the `.cache` directory
 * @returns the vector cache store
 */
export function diskVectorCacheStore({ cacheDir }: { cacheDir: string }): VectorCacheStore {
  const path = join(cacheDir, VECTOR_CACHE_FILE);
  return {
    append: async (vectors) => {
      if (vectors.length === 0) {
        return;
      }
      // Append-only durability, routed through safeFs (typed io error, re-thrown by orThrow): a kill
      // leaves the already-flushed rows intact.
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
    },
    load: async () => {
      const read = safeFs({ execute: () => readFileSync(path, "utf8"), operation: "vectorCache.load", path });
      if (read.isErr()) {
        return []; // missing/unreadable cache ⇒ empty (re-embed), never fatal
      }
      const vectors: CachedVector[] = [];
      for (const line of read.value.split("\n")) {
        const parsed = parseLine({ line });
        if (parsed !== undefined) {
          vectors.push(parsed);
        }
      }
      return vectors;
    },
    save: async (vectors) => {
      // Compaction is ATOMIC: build the whole file at a temp path, then rename over the target. A kill
      // mid-write can only leave the (discardable) temp file — never a truncated cache, so the appended
      // resume rows are never lost part-way through a rewrite. Rename is atomic on the same filesystem.
      // The whole sequence goes through safeFs (typed io error) and re-throws on failure.
      orThrow({
        result: safeFs({
          execute: () => {
            mkdirSync(cacheDir, { recursive: true });
            const tmp = `${path}.tmp`;
            writeFileSync(tmp, "", "utf8");
            for (let i = 0; i < vectors.length; i += SAVE_BATCH_ROWS) {
              const rows = vectors
                .slice(i, i + SAVE_BATCH_ROWS)
                .map((v) =>
                  JSON.stringify({ contentHash: v.contentHash, sourceId: v.sourceId, vector: Array.from(v.vector) }),
                );
              appendFileSync(tmp, rows.length > 0 ? `${rows.join("\n")}\n` : "", "utf8");
            }
            renameSync(tmp, path);
          },
          operation: "vectorCache.save",
          path,
        }),
      });
    },
  };
}
