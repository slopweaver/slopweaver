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
import { progressJsonEnabled, slopweaverHome } from "../../../config.js";
import { goldDir } from "../../../corpus/corpusPaths.js";
import { readCorpusDir, resolveCorpusDir } from "../../../corpus/corpusStore.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { type BatchDigest, type DistilRunResult, distilBatches } from "../../../gold/distil.js";
import { loadDistilCache, saveDistilCache } from "../../../gold/distilCache.js";
import { type DistilBatch, groupForDistil } from "../../../gold/distilGroup.js";
import { logger } from "../../../lib/logger.js";
import { createRichProgressEmitter } from "../../../lib/progress.js";
import { err, ok, type Result } from "../../../lib/result.js";
import { orThrow, safeFs } from "../../../lib/safeBoundary.js";
import { claudeCliClient } from "../../../llm/claudeCli.js";
import type { LlmClient } from "../../../llm/provider.js";
import { readSilverIndex } from "../../../silver/silverIndexRead.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import {
  buildDistilWritePlan,
  completeResultLine,
  type DistilOptions,
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
  const progress = createRichProgressEmitter({
    verb: "distil",
    ...(progressJsonEnabled() ? {} : { machineSink: () => {} }),
  });
  const runResult = await distilBatches({
    batches,
    cache,
    client,
    onCheckpoint: () => {
      saveDistilCache({ cache, home }); // persist NOW so a kill after this batch loses nothing
    },
    onLearning: (learning) => {
      progress.emit({ lane: "knowledge_extracted", learning, phase: "batch" });
    },
    onProgress: (p) => {
      progress.emit({
        done: p.done,
        lane: "heartbeat",
        metrics: { cached: p.hits, called: p.called, skipped: p.skipped },
        phase: "batch",
        total: p.total,
      });
    },
    ...(maxBatches !== undefined ? { maxCalls: maxBatches } : {}),
  });
  progress.finish({
    done: batches.length,
    lane: "heartbeat",
    metrics: { cached: runResult.hits, called: runResult.called, skipped: runResult.skipped },
    phase: "batch",
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

/** The corpus inputs a distil run needs: the batches, the digest cache, and the records they came from. */
interface DistilInputs {
  readonly batches: readonly DistilBatch[];
  readonly cache: Map<string, BatchDigest>;
  readonly records: readonly CorpusRecord[];
}

/**
 * Read the corpus → group into batches → load the digest cache (the effectful read half of the shell). A
 * corpus-dir resolution failure is an error Result; malformed rows surface as warnings.
 *
 * @param options the validated distil options
 * @param home the resolved world-model home
 * @returns the batches + cache + records, or the dir errors
 */
function loadDistilInputs({ options, home }: { options: DistilOptions; home: string }): Result<DistilInputs> {
  const dir = resolveCorpusDir({ home, ...(options.corpus !== undefined ? { corpus: options.corpus } : {}) });
  if (dir.ok === false) {
    return err(dir.errors);
  }
  const read = readCorpusDir({ dir: dir.value });
  // PR4.5 DECISION (see retrieval/accessScope.ts): the owner sees every lane, so gold summarises the WHOLE
  // corpus — private-lane records included. We deliberately do NOT filter private out here: gold is part
  // of the owner's own world model, and hiding a DM/private-channel discussion from your own summaries is
  // exactly the self-hiding we rejected. The private/public split gates only a (future) non-owner asker;
  // if a shared corpus is ever built, filter here on `visibilityForRecord` to keep private out of shared gold.
  const records = read.ok ? read.value : [];
  const batches = groupForDistil({
    records,
    ...(options.maxPerBatch !== undefined ? { maxPerBatch: options.maxPerBatch } : {}),
    ...(options.topContainers !== undefined ? { topContainersPerSource: options.topContainers } : {}),
    recentOnly: options.recentOnly,
  });
  return ok({ batches, cache: loadDistilCache({ home }), records }, read.warnings);
}

/** Print the `--dry-run` plan (batch counts + cache hit/miss) — no model call, no write. */
function runDistilDryRun({
  batches,
  cache,
  maxBatches,
}: {
  batches: readonly DistilBatch[];
  cache: Map<string, BatchDigest>;
  maxBatches: number | undefined;
}): void {
  const plan = planDistil({ batches, cache, maxBatches });
  for (const line of dryRunLines({ maxBatches, perSource: perSourceBatchCounts({ batches }), plan })) {
    logger.out(line);
  }
}

/**
 * The partial-output guard's report: gold is written ONLY when the digest set is COMPLETE. An incomplete
 * set — `--max-batches` DEFERRED batches or a batch FAILED — prints the partial/failed line (the cache is
 * already saved) so a later uncapped, error-fixed run completes it.
 */
function handleDistilIncomplete({ runResult }: { runResult: DistilRunResult }): void {
  logger.out(
    runResult.skipped > 0
      ? partialResultLine({ called: runResult.called, hits: runResult.hits, skipped: runResult.skipped })
      : failedResultLine({ called: runResult.called, failed: runResult.errors.length, hits: runResult.hits }),
  );
}

/** Build + write the silver digests and gold docs of a COMPLETE run, then print the gold path. */
function writeCompletedDistil({
  runResult,
  records,
  home,
  nowIso,
}: {
  runResult: DistilRunResult;
  records: readonly CorpusRecord[];
  home: string;
  nowIso: string;
}): void {
  writeDistilOutputs({
    writePlan: buildDistilWritePlan({
      builtAtIso: nowIso,
      home,
      silverIndex: readSilverIndex({ home }),
      sourceDigests: toSourceDigests({ digests: runResult.digests, records }),
    }),
  });
  logger.out(completeResultLine({ called: runResult.called, goldPath: goldDir({ home }), hits: runResult.hits }));
}

/** Handle `--help` + parse/validate the flag tail, reporting usage on error. Emits through the logger. */
function parseDistilOrReportUsage({
  rest,
}: {
  rest: readonly string[];
}): { kind: "exit"; code: number } | { kind: "go"; options: DistilOptions } {
  if (rest.includes("--help") || rest.includes("-h")) {
    logger.out(USAGE);
    return { code: EXIT_OK, kind: "exit" };
  }
  const options = parseDistilOptions({ rest });
  if (options.ok === false) {
    options.errors.forEach((e) => {
      logger.error(e);
    });
    logger.error(USAGE);
    return { code: EXIT_USAGE, kind: "exit" };
  }
  return { kind: "go", options: options.value };
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
  const parsed = parseDistilOrReportUsage({ rest: argv.slice(3) });
  if (parsed.kind === "exit") {
    return parsed.code;
  }
  const options = parsed.options;
  const home = options.home ?? slopweaverHome();
  const inputs = loadDistilInputs({ home, options });
  if (inputs.ok === false) {
    inputs.errors.forEach((e) => {
      logger.error(e);
    });
    return EXIT_ERROR;
  }
  inputs.warnings.forEach((w) => {
    logger.warn(w);
  });
  const { batches, cache, records } = inputs.value;
  const { maxBatches, dryRun } = options;

  if (dryRun) {
    runDistilDryRun({ batches, cache, maxBatches });
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
  // The partial-output guard: gold is written ONLY when the digest set is COMPLETE (an incomplete set —
  // deferred by `--max-batches` or left holed by a FAILED batch — would publish partial output over the
  // last complete build). The cache is already saved, so a later uncapped, error-fixed run completes it.
  if (!shouldWriteGold({ batchCount: batches.length, digestCount: runResult.digests.length })) {
    handleDistilIncomplete({ runResult });
    return EXIT_OK;
  }
  writeCompletedDistil({ home, nowIso: nowIso(), records, runResult });
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
