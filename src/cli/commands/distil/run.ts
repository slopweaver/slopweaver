/**
 * `slopweaver distil` — the LLM gold synthesis. Groups the corpus into batches, distils each into a
 * grounded digest (serving the content-hash cache, calling `claude` only for changed batches), reduces
 * to per-source silver digests, and renders gold markdown. `--dry-run` reports the batch plan + cache
 * hit/miss counts WITHOUT any LLM call or write — so you can preview the model spend first.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { slopweaverHome } from "../../../config.js";
import { goldDir, silverDigestsDir } from "../../../corpus/corpusPaths.js";
import { readCorpusDir, resolveCorpusDir } from "../../../corpus/corpusStore.js";
import type { CorpusRecord, CorpusSource } from "../../../corpus/types.js";
import { type BatchDigest, distilBatches, reduceToSourceDigest, type SourceDigest } from "../../../gold/distil.js";
import { loadDistilCache, saveDistilCache } from "../../../gold/distilCache.js";
import { type DistilBatch, groupForDistil } from "../../../gold/distilGroup.js";
import { buildGoldDocs } from "../../../gold/goldIndex.js";
import { writeJsonFile } from "../../../lib/jsonFile.js";
import { logger } from "../../../lib/logger.js";
import { createProgressEmitter, progressCadence } from "../../../lib/progress.js";
import { claudeCliClient } from "../../../llm/claudeCli.js";
import { readSilverIndex } from "../../../silver/silverIndexRead.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseFlagTail, parsePositiveInteger } from "../../optionParsers.js";

const USAGE =
  "usage: slopweaver distil [--home <dir>] [--corpus <dir>] [--max-per-batch N] [--top-containers N] [--max-batches N] [--recent-only] [--dry-run]";

/** Ascending string comparator (locale-independent), for a readable `.toSorted`. */
function compareStrings({ a, b }: { a: string; b: string }): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Batch count per source, sorted by source name — for the `--dry-run` plan summary. */
function perSourceBatchCounts({
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

/** Reduce fresh+cached digests into per-source silver digests. */
function toSourceDigests({
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

/**
 * Run the distil verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runDistil(argv: readonly string[]): Promise<number> {
  const rest = argv.slice(3);
  if (rest.includes("--help") || rest.includes("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  const parsed = parseFlagTail({
    rest,
    spec: {
      boolean: ["recent-only", "dry-run"],
      value: ["home", "corpus", "max-per-batch", "top-containers", "max-batches"],
    },
  });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      logger.error(e);
    });
    logger.error(USAGE);
    return EXIT_USAGE;
  }
  const { values, flags } = parsed.value;
  const home = values["home"] ?? slopweaverHome();

  const flagErrors: string[] = [];
  const maxPerBatch =
    values["max-per-batch"] !== undefined
      ? parsePositiveInteger({ errors: flagErrors, label: "--max-per-batch", value: values["max-per-batch"] })
      : undefined;
  const topContainers =
    values["top-containers"] !== undefined
      ? parsePositiveInteger({ errors: flagErrors, label: "--top-containers", value: values["top-containers"] })
      : undefined;
  const maxBatches =
    values["max-batches"] !== undefined
      ? parsePositiveInteger({ errors: flagErrors, label: "--max-batches", value: values["max-batches"] })
      : undefined;
  if (flagErrors.length > 0) {
    flagErrors.forEach((e) => {
      logger.error(e);
    });
    return EXIT_USAGE;
  }

  const dir = resolveCorpusDir({ home, ...(values["corpus"] !== undefined ? { corpus: values["corpus"] } : {}) });
  if (dir.ok === false) {
    dir.errors.forEach((e) => {
      logger.error(e);
    });
    return EXIT_ERROR;
  }
  const read = readCorpusDir({ dir: dir.value });
  read.warnings.forEach((w) => {
    logger.warn(w);
  });
  const records = read.ok ? read.value : [];

  const batches = groupForDistil({
    records,
    ...(maxPerBatch !== undefined ? { maxPerBatch } : {}),
    ...(topContainers !== undefined ? { topContainersPerSource: topContainers } : {}),
    recentOnly: flags.has("recent-only"),
  });
  const cache = loadDistilCache({ home });

  if (flags.has("dry-run")) {
    const misses = batches.filter((b) => !cache.has(b.hash)).length;
    const hits = batches.length - misses;
    const wouldCall = maxBatches !== undefined ? Math.min(misses, maxBatches) : misses;
    const capped = misses - wouldCall;
    logger.out(
      `${String(batches.length)} batch(es): ${String(hits)} cached, ${String(wouldCall)} would call the model` +
        (capped > 0 ? ` (${String(capped)} deferred by --max-batches ${String(maxBatches)})` : ""),
    );
    for (const [source, count] of perSourceBatchCounts({ batches })) {
      logger.out(`  ${source}: ${String(count)} batch(es)`);
    }
    logger.out("dry run — no model calls, no writes");
    return EXIT_OK;
  }
  if (batches.length === 0) {
    logger.out("no records to distil — run `slopweaver refresh` first");
    return EXIT_EXPECTED_EMPTY;
  }

  const misses = batches.filter((b) => !cache.has(b.hash)).length;
  const estCalls = maxBatches !== undefined ? Math.min(misses, maxBatches) : misses;
  logger.info(`distilling ${String(batches.length)} batch(es) — ~${String(estCalls)} model call(s) to make…`);
  // Non-blocking, session-visible progress + a per-batch cache flush so a killed run resumes losing nothing.
  const progress = createProgressEmitter({ cadence: progressCadence({ total: batches.length }), verb: "distil" });
  const run = await distilBatches({
    batches,
    cache,
    client: claudeCliClient(),
    onCheckpoint: () => {
      saveDistilCache({ cache, home });
    },
    onProgress: (p) => {
      progress.update({
        counts: { cached: p.hits, called: p.called, skipped: p.skipped },
        done: p.done,
        phase: "batch",
        total: p.total,
      });
    },
    ...(maxBatches !== undefined ? { maxCalls: maxBatches } : {}),
  });
  progress.finish({
    counts: { cached: run.hits, called: run.called, skipped: run.skipped },
    done: batches.length,
    phase: "done",
    total: batches.length,
  });
  run.errors.forEach((e) => {
    logger.warn(`skip ${e}`);
  });

  // The batch cache is always persisted (it's the resume unit). But when `--max-batches` deferred work,
  // the digest set is INCOMPLETE — writing silver/gold from it would publish partial output over the last
  // complete build. So on a capped run we save the cache only and tell the caller to re-run; a later
  // uncapped run distils the rest (all cache hits + the remaining calls) and writes complete gold.
  saveDistilCache({ cache, home });
  if (run.skipped > 0) {
    logger.out(
      `distilled ${String(run.called)} batch(es) (LLM) + ${String(run.hits)} cached · ${String(run.skipped)} deferred by --max-batches — cache saved, gold NOT rewritten (partial). Re-run to complete.`,
    );
    return EXIT_OK;
  }

  const sourceDigests = toSourceDigests({ digests: run.digests, records });
  for (const digest of sourceDigests) {
    writeJsonFile({ path: join(silverDigestsDir({ home }), `${digest.source}.json`), value: digest });
  }

  const index = readSilverIndex({ home });
  const docs = buildGoldDocs({
    builtAtIso: new Date().toISOString(),
    containers: index.containers,
    opportunities: index.opportunities,
    people: index.people,
    sources: sourceDigests,
  });
  for (const doc of docs) {
    const path = join(goldDir({ home }), doc.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, doc.markdown, "utf8");
  }

  logger.out(
    `distilled ${String(run.called)} batch(es) (LLM) + ${String(run.hits)} cached → gold at ${goldDir({ home })}`,
  );
  return EXIT_OK;
}

export const distilRunCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver distil --dry-run",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  run: runDistil,
  summary: "Distil the corpus into gold (LLM map-reduce; caches per batch)",
  usage: USAGE,
});
