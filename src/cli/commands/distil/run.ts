/**
 * `slopweaver distil` — the LLM gold synthesis. Groups the corpus into batches, distils each into a
 * grounded digest (serving the content-hash cache, calling `claude` only for changed batches), reduces
 * to per-source silver digests, and renders gold markdown. `--dry-run` reports the batch plan + cache
 * hit/miss counts WITHOUT any LLM call or write — so you can preview the model spend first.
 *
 * A thin effectful SHELL over the pure {@link ./core} (parse/plan/partition/format/write-plan): the LLM
 * client + the clock are INJECTED via {@link runDistilWithDeps}, so the partial-output guard and resume
 * are unit-tested end-to-end in the verb (not only at `distilBatches`). `runDistil(argv)` defaults the
 * client to the keyless `claudeCliClient()`.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { slopweaverHome } from "../../../config.js";
import { goldDir } from "../../../corpus/corpusPaths.js";
import { readCorpusDir, resolveCorpusDir } from "../../../corpus/corpusStore.js";
import { type BatchDigest, type DistilRunResult, distilBatches } from "../../../gold/distil.js";
import { loadDistilCache, saveDistilCache } from "../../../gold/distilCache.js";
import { type DistilBatch, groupForDistil } from "../../../gold/distilGroup.js";
import { logger } from "../../../lib/logger.js";
import { createProgressEmitter, progressCadence } from "../../../lib/progress.js";
import { orThrow, safeFs } from "../../../lib/safeBoundary.js";
import { claudeCliClient } from "../../../llm/claudeCli.js";
import type { LlmClient } from "../../../llm/provider.js";
import { readSilverIndex } from "../../../silver/silverIndexRead.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import {
  buildDistilWritePlan,
  completeResultLine,
  type DistilWritePlan,
  dryRunLines,
  failedResultLine,
  parseDistilOptions,
  partialResultLine,
  perSourceBatchCounts,
  planDistil,
  shouldWriteGold,
  toSourceDigests,
} from "./core.js";

const USAGE =
  "usage: slopweaver distil [--home <dir>] [--corpus <dir>] [--max-per-batch N] [--top-containers N] [--max-batches N] [--recent-only] [--dry-run]";

/** Write a text file, creating parent dirs — routed through safeFs (typed io error, re-thrown on failure). */
function writeTextFile({ path, text }: { path: string; text: string }): void {
  orThrow({
    result: safeFs({
      execute: () => {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, text, "utf8");
      },
      operation: "distil.writeGoldDoc",
      path,
    }),
  });
}

/**
 * Distil every batch with session-visible progress + a per-batch cache checkpoint, then persist the cache
 * (the resume unit). The effectful batch-run half of the shell.
 *
 * @param batches the batches to distil
 * @param cache the content-hash → digest cache (mutated with fresh digests)
 * @param client the LLM transport
 * @param home the world-model home (where the cache is checkpointed)
 * @param maxBatches optional cap on fresh model calls
 * @returns the distil run result (digests, counts, per-batch errors)
 */
async function executeDistil({
  batches,
  cache,
  client,
  home,
  maxBatches,
}: {
  batches: readonly DistilBatch[];
  cache: Map<string, BatchDigest>;
  client: LlmClient;
  home: string;
  maxBatches?: number;
}): Promise<DistilRunResult> {
  const plan = planDistil({ batches, cache, maxBatches });
  logger.info(`distilling ${String(batches.length)} batch(es) — ~${String(plan.wouldCall)} model call(s) to make…`);
  const progress = createProgressEmitter({ cadence: progressCadence({ total: batches.length }), verb: "distil" });
  const runResult = await distilBatches({
    batches,
    cache,
    client,
    onCheckpoint: () => {
      saveDistilCache({ cache, home }); // persist NOW so a kill after this batch loses nothing
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
    counts: { cached: runResult.hits, called: runResult.called, skipped: runResult.skipped },
    done: batches.length,
    phase: "done",
    total: batches.length,
  });
  runResult.errors.forEach((e) => {
    logger.warn(`skip ${e}`);
  });
  saveDistilCache({ cache, home }); // always persisted — it's the resume unit
  return runResult;
}

/** Write the silver digests + gold docs a completed run produced (the effectful write half of the shell). */
function writeDistilOutputs({ writePlan }: { writePlan: DistilWritePlan }): void {
  for (const file of writePlan.silverDigests) {
    writeTextFile({ path: file.path, text: `${JSON.stringify(file.content, null, 2)}\n` });
  }
  for (const file of writePlan.goldDocs) {
    writeTextFile({ path: file.path, text: file.content });
  }
}

/**
 * Run the distil verb over injected dependencies (the LLM client + a clock). The testable shell: every
 * pure decision comes from {@link ./core}; this performs the reads, the model calls, and the writes.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @param client the LLM transport (a fake in tests, `claudeCliClient()` in production)
 * @param nowIso the build-timestamp clock (injected for deterministic tests)
 * @returns the process exit code
 */
export async function runDistilWithDeps({
  argv,
  client,
  nowIso = () => new Date().toISOString(),
}: {
  argv: readonly string[];
  client: LlmClient;
  nowIso?: () => string;
}): Promise<number> {
  const rest = argv.slice(3);
  if (rest.includes("--help") || rest.includes("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  const options = parseDistilOptions({ rest });
  if (options.ok === false) {
    options.errors.forEach((e) => {
      logger.error(e);
    });
    logger.error(USAGE);
    return EXIT_USAGE;
  }
  const { home = slopweaverHome(), corpus, maxPerBatch, topContainers, maxBatches, recentOnly, dryRun } = options.value;

  const dir = resolveCorpusDir({ home, ...(corpus !== undefined ? { corpus } : {}) });
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
    recentOnly,
  });
  const cache = loadDistilCache({ home });

  if (dryRun) {
    const plan = planDistil({ batches, cache, maxBatches });
    for (const line of dryRunLines({ maxBatches, perSource: perSourceBatchCounts({ batches }), plan })) {
      logger.out(line);
    }
    return EXIT_OK;
  }
  if (batches.length === 0) {
    logger.out("no records to distil — run `slopweaver refresh` first");
    return EXIT_EXPECTED_EMPTY;
  }

  const runResult = await executeDistil({
    batches,
    cache,
    client,
    home,
    ...(maxBatches !== undefined ? { maxBatches } : {}),
  });

  // The partial-output guard: gold is written ONLY when the digest set is COMPLETE. An incomplete set —
  // whether `--max-batches` DEFERRED batches or a batch FAILED — would publish partial output over the last
  // complete build, so we save the cache only (done in executeDistil) and tell the caller to re-run. A later
  // uncapped run with the errors fixed completes it (all hits + the rest) and writes complete gold.
  if (!shouldWriteGold({ batchCount: batches.length, digestCount: runResult.digests.length })) {
    logger.out(
      runResult.skipped > 0
        ? partialResultLine({ called: runResult.called, hits: runResult.hits, skipped: runResult.skipped })
        : failedResultLine({ called: runResult.called, failed: runResult.errors.length, hits: runResult.hits }),
    );
    return EXIT_OK;
  }

  writeDistilOutputs({
    writePlan: buildDistilWritePlan({
      builtAtIso: nowIso(),
      home,
      silverIndex: readSilverIndex({ home }),
      sourceDigests: toSourceDigests({ digests: runResult.digests, records }),
    }),
  });
  logger.out(completeResultLine({ called: runResult.called, goldPath: goldDir({ home }), hits: runResult.hits }));
  return EXIT_OK;
}

/**
 * Run the distil verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runDistil(argv: readonly string[]): Promise<number> {
  return runDistilWithDeps({ argv, client: claudeCliClient() });
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
