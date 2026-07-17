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
import { groupForDistil } from "../../../gold/distilGroup.js";
import { buildGoldDocs } from "../../../gold/goldIndex.js";
import { writeJsonFile } from "../../../lib/jsonFile.js";
import { logger } from "../../../lib/logger.js";
import { claudeCliClient } from "../../../llm/claudeCli.js";
import { readSilverIndex } from "../../../silver/silverIndexRead.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseFlagTail, parsePositiveInteger } from "../../optionParsers.js";

const USAGE =
  "usage: slopweaver distil [--home <dir>] [--corpus <dir>] [--max-per-batch N] [--top-containers N] [--recent-only] [--dry-run]";

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
    spec: { boolean: ["recent-only", "dry-run"], value: ["home", "corpus", "max-per-batch", "top-containers"] },
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
    const hits = batches.filter((b) => cache.has(b.hash)).length;
    logger.out(
      `${String(batches.length)} batch(es): ${String(hits)} cached, ${String(batches.length - hits)} would call the model`,
    );
    return EXIT_OK;
  }
  if (batches.length === 0) {
    logger.out("no records to distil — run `slopweaver refresh` first");
    return EXIT_EXPECTED_EMPTY;
  }

  logger.info(`distilling ${String(batches.length)} batch(es)…`);
  const run = await distilBatches({ batches, cache, client: claudeCliClient() });
  run.errors.forEach((e) => {
    logger.warn(`skip ${e}`);
  });

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
  saveDistilCache({ cache, home });

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
