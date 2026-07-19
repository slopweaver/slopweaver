/**
 * distil — the LLM map step. One batch → one grounded digest via a forced-tool structured call. Pure
 * prompt/validate helpers; the single effect (the model call) goes through the injected `LlmClient`
 * (the keyless `claude` CLI in production, a fake in tests). Every digest point must cite a url/id or
 * it's dropped — gold is only as trustworthy as its grounding.
 */

import type { CorpusRecord, CorpusSource } from "../corpus/types.js";
import { isRecord } from "../lib/parsers.js";
import { err, ok, type Result } from "../lib/result.js";
import type { JsonObjectSchema, LlmClient } from "../llm/provider.js";
import { completeStructured } from "../llm/structuredComplete.js";
import type { DistilBatch } from "./distilGroup.js";

export interface DigestPoint {
  readonly point: string;
  readonly citations: readonly string[];
}

export interface BatchDigest {
  readonly source: CorpusSource;
  readonly container: string;
  readonly summary: string;
  readonly points: readonly DigestPoint[];
}

export interface SourceDigest {
  readonly source: CorpusSource;
  readonly recordCount: number;
  readonly containers: readonly BatchDigest[];
}

export const DIGEST_SCHEMA: JsonObjectSchema = {
  properties: {
    points: {
      items: {
        properties: { citations: { items: { type: "string" }, type: "array" }, point: { type: "string" } },
        type: "object",
      },
      type: "array",
    },
    summary: { type: "string" },
  },
  required: ["summary", "points"],
  type: "object",
};

const SYSTEM = [
  "You distil one container of team activity into a high-signal digest.",
  "Write a one-sentence summary, then a handful of concrete points.",
  "Ground EVERY point: cite the url or id of the record(s) it comes from. A point with no citation is dropped.",
  "Prefer decisions, outcomes, blockers, and ownership over restating chatter.",
].join(" ");

/** Render one record as a prompt block (capped so a batch stays within budget). */
function recordBlock({ record }: { record: CorpusRecord }): string {
  const head = `[${record.kind}${record.author !== undefined ? ` by ${record.author}` : ""} · ${record.tsIso}]`;
  const body = [record.title, record.text]
    .filter((part) => part !== undefined)
    .join("\n")
    .slice(0, 1200);
  const refs = record.refs.length > 0 ? `\nrefs: ${record.refs.join(", ")}` : "";
  return `${head} ${record.url}\n${body}${refs}`;
}

/**
 * Build the distil prompt for a batch.
 *
 * @param batch the batch to digest
 * @returns the `system` + `user` prompt
 */
export function buildDigestPrompt({ batch }: { batch: DistilBatch }): { system: string; user: string } {
  const header = `Source: ${batch.source}\nContainer: ${batch.container}\nRecords: ${String(batch.records.length)}\n`;
  const user = `${header}\n${batch.records.map((record) => recordBlock({ record })).join("\n\n")}`;
  return { system: SYSTEM, user };
}

/**
 * Validate a model digest against a batch: keep only points that have text AND at least one citation.
 *
 * @param batch the batch being digested (supplies source/container)
 * @param input the raw model output
 * @returns the validated digest, or an error (triggering a retry)
 */
export function validateBatchDigest({ batch, input }: { batch: DistilBatch; input: unknown }): Result<BatchDigest> {
  if (!isRecord(input) || typeof input["summary"] !== "string" || !Array.isArray(input["points"])) {
    return err(["digest must have a string summary and a points array"]);
  }
  const points: DigestPoint[] = [];
  for (const raw of input["points"]) {
    if (!isRecord(raw) || typeof raw["point"] !== "string" || raw["point"].trim().length === 0) {
      continue;
    }
    const citations = Array.isArray(raw["citations"])
      ? raw["citations"].filter((c): c is string => typeof c === "string" && c.trim().length > 0)
      : [];
    if (citations.length > 0) {
      points.push({ citations, point: raw["point"] });
    }
  }
  const summary = input["summary"].trim();
  if (summary.length === 0 && points.length === 0) {
    return err(["digest had neither a summary nor any cited point"]);
  }
  return ok({ container: batch.container, points, source: batch.source, summary });
}

/**
 * Distil one batch into a digest via the LLM (forced-tool + validate + retry).
 *
 * @param batch the batch to digest
 * @param client the LLM transport
 * @returns the digest, or an error
 */
export async function distilBatch({
  batch,
  client,
}: {
  batch: DistilBatch;
  client: LlmClient;
}): Promise<Result<BatchDigest>> {
  const { system, user } = buildDigestPrompt({ batch });
  return completeStructured({
    client,
    request: {
      schema: DIGEST_SCHEMA,
      system,
      toolDescription: "Emit the container digest.",
      toolName: "emit_digest",
      user,
    },
    validate: (input) => validateBatchDigest({ batch, input }),
  });
}

export interface DistilRunResult {
  readonly digests: readonly BatchDigest[];
  readonly called: number;
  readonly hits: number;
  /** Uncached batches left un-distilled because `maxCalls` was reached (a resume will pick them up). */
  readonly skipped: number;
  readonly errors: readonly string[];
}

/** Per-batch progress snapshot, emitted after each batch so a long run is visible + resumable. */
export interface DistilProgress {
  readonly done: number;
  readonly total: number;
  readonly called: number;
  readonly hits: number;
  readonly skipped: number;
}

/**
 * Distil every batch, serving cache hits and calling the LLM only for misses. Mutates `cache` with each
 * fresh digest; `onCheckpoint` fires after each fresh digest so the caller can PERSIST per-batch (making
 * a killed run resumable). `maxCalls` caps fresh model calls (the `--max-batches` safety valve); once
 * reached, further misses are counted as `skipped` and left for a resume. A per-batch failure is recorded
 * and skipped (non-fatal).
 *
 * @param batches the batches to distil
 * @param cache the content-hash → digest cache (mutated with fresh digests)
 * @param client the LLM transport
 * @param maxCalls optional cap on fresh model calls (cached batches are always served)
 * @param onProgress optional per-batch progress callback (non-blocking)
 * @param onCheckpoint optional callback after each fresh digest is cached (persist the cache here)
 * @returns the digests (cached + fresh), counts, and any per-batch errors
 */
export async function distilBatches({
  batches,
  cache,
  client,
  maxCalls,
  onProgress,
  onCheckpoint,
}: {
  batches: readonly DistilBatch[];
  cache: Map<string, BatchDigest>;
  client: LlmClient;
  maxCalls?: number;
  onProgress?: (progress: DistilProgress) => void;
  onCheckpoint?: () => void;
}): Promise<DistilRunResult> {
  const digests: BatchDigest[] = [];
  const errors: string[] = [];
  let called = 0;
  let hits = 0;
  let skipped = 0;
  let done = 0;
  const total = batches.length;
  for (const batch of batches) {
    const cached = cache.get(batch.hash);
    if (cached !== undefined) {
      digests.push(cached);
      hits += 1;
    } else if (maxCalls !== undefined && called >= maxCalls) {
      skipped += 1; // budget spent — leave this miss for a resume
    } else {
      const result = await distilBatch({ batch, client });
      if (result.ok) {
        cache.set(batch.hash, result.value);
        digests.push(result.value);
        called += 1;
        onCheckpoint?.(); // persist NOW so a kill after this batch loses nothing
      } else {
        errors.push(`${batch.source}/${batch.container}: ${result.errors.join("; ")}`);
      }
    }
    done += 1;
    onProgress?.({ called, done, hits, skipped, total });
  }
  return { called, digests, errors, hits, skipped };
}

/**
 * Reduce per-container digests into a per-source digest (richest containers first).
 *
 * @param source the source
 * @param digests the container digests for that source
 * @param recordCount total records for the source
 * @returns the source digest
 */
export function reduceToSourceDigest({
  source,
  digests,
  recordCount,
}: {
  source: CorpusSource;
  digests: readonly BatchDigest[];
  recordCount: number;
}): SourceDigest {
  const containers = [...digests].toSorted(
    (a, b) => b.points.length - a.points.length || (a.container < b.container ? -1 : a.container > b.container ? 1 : 0),
  );
  return { containers, recordCount, source };
}
