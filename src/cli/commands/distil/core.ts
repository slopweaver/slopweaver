/**
 * The pure core of the `distil` verb — parse, plan, partition, format, and the write plan — extracted from
 * the old 142-line `runDistil` so each concern is unit-tested apart from the LLM/filesystem IO the shell
 * owns. Nothing here touches the network, the model, the clock, or the disk; the shell ({@link ./run})
 * injects the LLM client + a clock and performs the writes these functions describe.
 */
import { join } from "node:path";
import { goldDir, silverDigestsDir } from "../../../corpus/corpusPaths.js";
import type { CorpusRecord, CorpusSource } from "../../../corpus/types.js";
import type { BatchDigest, SourceDigest } from "../../../gold/distil.js";
import { reduceToSourceDigest } from "../../../gold/distil.js";
import type { DistilBatch } from "../../../gold/distilGroup.js";
import { buildGoldDocs } from "../../../gold/goldIndex.js";
import { err, ok, type Result } from "../../../lib/result.js";
import type { SilverIndex } from "../../../silver/silverIndexRead.js";
import { parseFlagTail, parsePositiveInteger } from "../../optionParsers.js";

/** The validated `distil` options (mirrors the verb's flags). */
export interface DistilOptions {
  readonly home?: string;
  readonly corpus?: string;
  readonly maxPerBatch?: number;
  readonly topContainers?: number;
  readonly maxBatches?: number;
  readonly recentOnly: boolean;
  readonly dryRun: boolean;
}

/**
 * Parse + validate the `distil` flag tail into typed options. Pure — a bad flag or a non-positive integer
 * yields an error Result, never a throw.
 *
 * @param rest the verb tail (argv from index 3)
 * @returns the validated options, or the accumulated flag errors
 */
export function parseDistilOptions({ rest }: { rest: readonly string[] }): Result<DistilOptions> {
  const parsed = parseFlagTail({
    rest,
    spec: {
      boolean: ["recent-only", "dry-run"],
      value: ["home", "corpus", "max-per-batch", "top-containers", "max-batches"],
    },
  });
  if (parsed.ok === false) {
    return err(parsed.errors);
  }
  const { values, flags } = parsed.value;
  const errors: string[] = [];
  const positive = (label: string, key: string): number | undefined =>
    values[key] !== undefined ? parsePositiveInteger({ errors, label, value: values[key] }) : undefined;
  const maxPerBatch = positive("--max-per-batch", "max-per-batch");
  const topContainers = positive("--top-containers", "top-containers");
  const maxBatches = positive("--max-batches", "max-batches");
  if (errors.length > 0) {
    return err(errors);
  }
  return ok({
    dryRun: flags.has("dry-run"),
    recentOnly: flags.has("recent-only"),
    ...(values["home"] !== undefined ? { home: values["home"] } : {}),
    ...(values["corpus"] !== undefined ? { corpus: values["corpus"] } : {}),
    ...(maxPerBatch !== undefined ? { maxPerBatch } : {}),
    ...(topContainers !== undefined ? { topContainers } : {}),
    ...(maxBatches !== undefined ? { maxBatches } : {}),
  });
}

/** The cache-hit/miss plan for a set of batches (drives both the dry-run summary + the call estimate). */
export interface DistilPlan {
  readonly total: number;
  readonly hits: number;
  readonly misses: number;
  readonly wouldCall: number;
  readonly capped: number;
}

/**
 * Plan the batch run against the cache: how many are cached, how many misses would call the model, and how
 * many misses `--max-batches` would defer. Pure.
 *
 * @param batches the batches to distil
 * @param cache the content-hash → digest cache
 * @param maxBatches optional cap on fresh model calls
 * @returns the plan counts
 */
export function planDistil({
  batches,
  cache,
  maxBatches,
}: {
  batches: readonly DistilBatch[];
  cache: ReadonlyMap<string, BatchDigest>;
  maxBatches: number | undefined;
}): DistilPlan {
  const misses = batches.filter((b) => !cache.has(b.hash)).length;
  const hits = batches.length - misses;
  const wouldCall = maxBatches !== undefined ? Math.min(misses, maxBatches) : misses;
  return { capped: misses - wouldCall, hits, misses, total: batches.length, wouldCall };
}

/** Ascending string comparator (locale-independent), for a readable `.toSorted`. */
function compareStrings({ a, b }: { a: string; b: string }): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Batch count per source, sorted by source name — for the `--dry-run` plan summary. Pure.
 *
 * @param batches the batches
 * @returns `[source, count]` pairs, source-sorted
 */
export function perSourceBatchCounts({
  batches,
}: {
  batches: readonly DistilBatch[];
}): readonly (readonly [CorpusSource, number])[] {
  const counts = new Map<CorpusSource, number>();
  for (const batch of batches) {
    counts.set(batch.source, (counts.get(batch.source) ?? 0) + 1);
  }
  return [...counts.entries()].toSorted(([sourceA], [sourceB]) => compareStrings({ a: sourceA, b: sourceB }));
}

/**
 * The exact lines `--dry-run` prints (header + per-source + trailer). Pure — the shell just emits them.
 *
 * @param plan the batch plan
 * @param perSource the per-source batch counts
 * @param maxBatches the `--max-batches` cap (named in the deferred-count note)
 * @returns the dry-run report lines
 */
export function dryRunLines({
  plan,
  perSource,
  maxBatches,
}: {
  plan: DistilPlan;
  perSource: readonly (readonly [CorpusSource, number])[];
  maxBatches: number | undefined;
}): readonly string[] {
  const lines = [
    `${String(plan.total)} batch(es): ${String(plan.hits)} cached, ${String(plan.wouldCall)} would call the model` +
      (plan.capped > 0 ? ` (${String(plan.capped)} deferred by --max-batches ${String(maxBatches)})` : ""),
  ];
  for (const [source, count] of perSource) {
    lines.push(`  ${source}: ${String(count)} batch(es)`);
  }
  lines.push("dry run — no model calls, no writes");
  return lines;
}

/**
 * Whether a completed run should write silver/gold: ONLY when the digest set is COMPLETE — i.e. every
 * batch produced a digest (`digestCount === batchCount`). This is the full partial-output guard: it holds
 * both when `--max-batches` DEFERRED batches (skipped) AND when a batch FAILED (a per-batch LLM/validation
 * error left a hole), since either leaves `digests.length < batches.length`. Writing from an incomplete set
 * would publish partial output over the last complete build.
 *
 * @param digestCount the number of digests produced (cached hits + fresh successes)
 * @param batchCount the total number of batches
 * @returns true only when every batch is accounted for
 */
export function shouldWriteGold({ digestCount, batchCount }: { digestCount: number; batchCount: number }): boolean {
  return digestCount === batchCount;
}

/** The report line for a capped (deferred) run — cache saved, gold deliberately NOT rewritten. */
export function partialResultLine({
  called,
  hits,
  skipped,
}: {
  called: number;
  hits: number;
  skipped: number;
}): string {
  return (
    `distilled ${String(called)} batch(es) (LLM) + ${String(hits)} cached · ${String(skipped)} deferred by ` +
    "--max-batches — cache saved, gold NOT rewritten (partial). Re-run to complete."
  );
}

/** The report line for a run where batches FAILED (not deferred) — the digest set is incomplete, gold withheld. */
export function failedResultLine({ called, hits, failed }: { called: number; hits: number; failed: number }): string {
  return (
    `distilled ${String(called)} batch(es) (LLM) + ${String(hits)} cached · ${String(failed)} batch(es) failed ` +
    "— cache saved, gold NOT rewritten (incomplete). Fix the errors and re-run to complete."
  );
}

/** The report line for a complete run (gold written). */
export function completeResultLine({
  called,
  hits,
  goldPath,
}: {
  called: number;
  hits: number;
  goldPath: string;
}): string {
  return `distilled ${String(called)} batch(es) (LLM) + ${String(hits)} cached → gold at ${goldPath}`;
}

/**
 * Reduce fresh+cached batch digests into per-source silver digests (the source-digest partitioning). Pure.
 *
 * @param digests every batch digest (cached + fresh)
 * @param records the corpus records (for per-source record counts)
 * @returns one digest per source
 */
export function toSourceDigests({
  digests,
  records,
}: {
  digests: readonly BatchDigest[];
  records: readonly CorpusRecord[];
}): readonly SourceDigest[] {
  const bySource = new Map<CorpusSource, BatchDigest[]>();
  for (const digest of digests) {
    const list = bySource.get(digest.source) ?? [];
    list.push(digest);
    bySource.set(digest.source, list);
  }
  return [...bySource.entries()].map(([source, sourceDigests]) =>
    reduceToSourceDigest({
      digests: sourceDigests,
      recordCount: records.filter((r) => r.source === source).length,
      source,
    }),
  );
}

/** One file to write, resolved to an absolute path + its serialisable content. */
export interface WriteFile<T> {
  readonly path: string;
  readonly content: T;
}

/** The full set of files a completed distil writes: per-source silver digests + the gold markdown docs. */
export interface DistilWritePlan {
  readonly silverDigests: readonly WriteFile<SourceDigest>[];
  readonly goldDocs: readonly WriteFile<string>[];
}

/**
 * Build the complete write plan (silver digest JSON + gold markdown), resolved to absolute paths. Pure —
 * given the reduced digests, the silver index, and the build timestamp, it describes every file the shell
 * must write, so the "what gets written" is unit-tested without touching disk.
 *
 * @param sourceDigests the per-source digests
 * @param silverIndex the directory + opportunities read back from silver
 * @param builtAtIso the build timestamp stamped into the gold overview
 * @param home the world-model home the paths resolve under
 * @returns the silver + gold files to write
 */
export function buildDistilWritePlan({
  sourceDigests,
  silverIndex,
  builtAtIso,
  home,
}: {
  sourceDigests: readonly SourceDigest[];
  silverIndex: SilverIndex;
  builtAtIso: string;
  home: string;
}): DistilWritePlan {
  const silverDigests = sourceDigests.map((digest) => ({
    content: digest,
    path: join(silverDigestsDir({ home }), `${digest.source}.json`),
  }));
  const goldDocs = buildGoldDocs({
    builtAtIso,
    containers: silverIndex.containers,
    opportunities: silverIndex.opportunities,
    people: silverIndex.people,
    sources: sourceDigests,
  }).map((doc) => ({ content: doc.markdown, path: join(goldDir({ home }), doc.path) }));
  return { goldDocs, silverDigests };
}
