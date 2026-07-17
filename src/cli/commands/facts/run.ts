/**
 * `slopweaver facts` — retrieve-only. Same ranked slice `ask` would ground in, printed as raw records
 * (source · cite token · url · title · snippet) for a human or a subagent to reason over. No LLM call.
 */

import { slopweaverHome } from "../../../config.js";
import { cacheDir } from "../../../corpus/corpusPaths.js";
import { logger } from "../../../lib/logger.js";
import { retrieveRecords } from "../../../retrieval/askEngine.js";
import { citeToken } from "../../../retrieval/citeToken.js";
import { defaultEmbedder } from "../../../retrieval/embeddings.js";
import { loadCorpus } from "../../../retrieval/loadCorpus.js";
import { decayParamsFromDays } from "../../../retrieval/recencyDecay.js";
import { prepareSemanticContext } from "../../../retrieval/semanticRetrieval.js";
import { diskVectorCacheStore } from "../../../retrieval/vectorCacheStore.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseQueryArgs } from "../queryArgs.js";

const USAGE =
  "usage: slopweaver facts <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--home <dir>] [--corpus <dir>]";
const DEFAULT_LIMIT = 12;

/**
 * Run the facts verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runFacts(argv: readonly string[]): Promise<number> {
  const rest = argv.slice(3);
  if (rest.includes("--help") || rest.includes("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  const args = parseQueryArgs({ defaultLimit: DEFAULT_LIMIT, rest });
  if (args.errors.length > 0) {
    args.errors.forEach((e) => {
      logger.error(e);
    });
    logger.error(USAGE);
    return EXIT_USAGE;
  }
  if (args.question.trim().length === 0) {
    logger.error("facts needs a question");
    logger.error(USAGE);
    return EXIT_USAGE;
  }

  const home = args.home ?? slopweaverHome();
  const nowMs = Date.now();
  const corpus = loadCorpus({
    home,
    ...(args.corpus !== undefined ? { corpus: args.corpus } : {}),
    nowIso: new Date(nowMs).toISOString(),
  });
  if (corpus.ok === false) {
    logger.out("no corpus yet — run `slopweaver refresh` first");
    return EXIT_EXPECTED_EMPTY;
  }
  corpus.warnings.forEach((w) => {
    logger.warn(w);
  });
  const records = corpus.value;

  const semanticPrep = args.semantic
    ? await prepareSemanticContext({
        deps: { embedder: defaultEmbedder, store: diskVectorCacheStore({ cacheDir: cacheDir({ home }) }) },
        enabled: true,
        query: args.question,
        records,
        warn: (m) => {
          logger.warn(m);
        },
      })
    : { degraded: false as const };

  const slice = retrieveRecords({
    decay: decayParamsFromDays({ days: args.halfLifeDays, nowMs }),
    question: args.question,
    records,
    sliceLimit: args.limit,
    ...(semanticPrep.context !== undefined ? { semantic: semanticPrep.context } : {}),
    ...(args.alpha !== undefined ? { alpha: args.alpha } : {}),
  });
  if (slice.length === 0) {
    logger.out("no matching records");
    return EXIT_OK;
  }
  for (const record of slice) {
    const snippet = record.text.replace(/\s+/g, " ").slice(0, 200);
    logger.out(`[${record.source}] (${citeToken({ record })}) ${record.url}`);
    if (record.title !== undefined && record.title.length > 0) {
      logger.out(`  ${record.title}`);
    }
    logger.out(`  ${snippet}`);
    logger.out("");
  }
  return EXIT_OK;
}

export const factsRunCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: 'slopweaver facts "auth flow"',
  parseRejectIsIoFree: false,
  requiresApproval: false,
  run: runFacts,
  summary: "Retrieve the ranked record slice for a question (no LLM)",
  usage: USAGE,
});
