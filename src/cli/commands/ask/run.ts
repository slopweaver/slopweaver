/**
 * `slopweaver ask` — answer a question from the local world model. Loads bronze + gold, retrieves a
 * ranked slice (hybrid BM25⊕cosine, fail-soft to BM25), and composes a grounded, cited answer via the
 * keyless `claude` transport. `--no-semantic` forces BM25-only (skips the embedder).
 */

import { slopweaverHome } from "../../../config.js";
import { cacheDir } from "../../../corpus/corpusPaths.js";
import { logger } from "../../../lib/logger.js";
import { createProgressEmitter } from "../../../lib/progress.js";
import { claudeCliClient } from "../../../llm/claudeCli.js";
import { answerQuestion } from "../../../retrieval/askEngine.js";
import { defaultEmbedder } from "../../../retrieval/embeddings.js";
import { loadCorpus } from "../../../retrieval/loadCorpus.js";
import { decayParamsFromDays } from "../../../retrieval/recencyDecay.js";
import { prepareSemanticContext } from "../../../retrieval/semanticRetrieval.js";
import { diskVectorCacheStore } from "../../../retrieval/vectorCacheStore.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseQueryArgs } from "../queryArgs.js";
import { renderAskJson } from "./askJson.js";

const USAGE =
  "usage: slopweaver ask <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--json] [--home <dir>] [--corpus <dir>]";
const DEFAULT_LIMIT = 12;

/**
 * Run the ask verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runAsk(argv: readonly string[]): Promise<number> {
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
    logger.error("ask needs a question");
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

  // Route embed progress to STDERR so it never corrupts the answer / `--json` on stdout.
  const embedProgress = createProgressEmitter({
    sink: (line) => {
      process.stderr.write(line);
    },
    verb: "embed",
  });
  const semanticPrep = args.semantic
    ? await prepareSemanticContext({
        deps: { embedder: defaultEmbedder, store: diskVectorCacheStore({ cacheDir: cacheDir({ home }) }) },
        enabled: true,
        onProgress: (p) => {
          embedProgress.update({ done: p.done, phase: "records", total: p.total });
        },
        query: args.question,
        records,
        warn: (m) => {
          logger.warn(m);
        },
      })
    : { degraded: false as const };

  const answer = await answerQuestion({
    client: claudeCliClient(),
    decay: decayParamsFromDays({ days: args.halfLifeDays, nowMs }),
    question: args.question,
    records,
    sliceLimit: args.limit,
    ...(semanticPrep.context !== undefined ? { semantic: semanticPrep.context } : {}),
    ...(args.alpha !== undefined ? { alpha: args.alpha } : {}),
  });
  if (answer.ok === false) {
    answer.errors.forEach((e) => {
      logger.error(e);
    });
    return EXIT_ERROR;
  }

  // `--json`: one machine-readable object on stdout (diagnostics stay on stderr), for the eval harness.
  if (args.json) {
    logger.out(renderAskJson({ answer: answer.value, question: args.question }));
    return answer.value.retrieved > 0 ? EXIT_OK : EXIT_EXPECTED_EMPTY;
  }

  const { tldr, details, citations, retrieved } = answer.value;
  logger.out(tldr);
  if (details !== undefined && details.length > 0) {
    logger.out("");
    logger.out(details);
  }
  if (citations.length > 0) {
    logger.out("");
    logger.out("citations:");
    citations.forEach((c) => {
      logger.out(`  ${c}`);
    });
  }
  // Expected-empty ONLY when the query retrieved nothing — a substantive answer with no surviving
  // citations is still a real answer (exit 0), not "nothing matched".
  return retrieved > 0 ? EXIT_OK : EXIT_EXPECTED_EMPTY;
}

export const askRunCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: 'slopweaver ask "what changed in the refresh pipeline?"',
  parseRejectIsIoFree: false,
  requiresApproval: false,
  run: runAsk,
  summary: "Ask a grounded question of your local world model",
  usage: USAGE,
});
