/**
 * `slopweaver facts` — retrieve-only. Same ranked slice `ask` would ground in, printed as raw records
 * (source · cite token · url · title · snippet) for a human or a subagent to reason over. No LLM call.
 *
 * A thin effectful shell: validation, snippet normalisation, line rendering, and exit codes come from the
 * pure {@link ../query/core}; the corpus load + semantic prep + retrieval are INJECTED via
 * {@link runFactsWithDeps}. `runFacts(argv)` wires production dependencies.
 */

import { slopweaverHome } from "../../../config.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { logger } from "../../../lib/logger.js";
import type { Result } from "../../../lib/result.js";
import { retrieveRecords } from "../../../retrieval/askEngine.js";
import { loadCorpus } from "../../../retrieval/loadCorpus.js";
import { decayParamsFromDays } from "../../../retrieval/recencyDecay.js";
import type { SemanticPreparation } from "../../../retrieval/semanticRetrieval.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { factsExitCode, renderFactsLines, validateFactsQuestion } from "../query/core.js";
import { prepareSemanticForQuery } from "../query/shell.js";
import { parseQueryArgs } from "../queryArgs.js";

const USAGE =
  "usage: slopweaver facts <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--home <dir>] [--corpus <dir>]";
const DEFAULT_LIMIT = 12;

/** The injectable effectful seams the `facts` shell composes (fakes in tests, production wiring in {@link runFacts}). */
export interface FactsDeps {
  readonly home: () => string;
  readonly nowMs: () => number;
  readonly loadCorpus: (args: { home: string; corpus?: string; nowIso: string }) => Result<readonly CorpusRecord[]>;
  readonly prepareSemantic: (args: {
    home: string;
    question: string;
    records: readonly CorpusRecord[];
    semantic: boolean;
  }) => Promise<SemanticPreparation>;
  readonly retrieveRecords: typeof retrieveRecords;
  readonly logger: { out: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/**
 * Run the facts verb over injected dependencies — the testable shell.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @param deps the effectful seams
 * @returns the process exit code
 */
export async function runFactsWithDeps({ argv, deps }: { argv: readonly string[]; deps: FactsDeps }): Promise<number> {
  const rest = argv.slice(3);
  if (rest.includes("--help") || rest.includes("-h")) {
    deps.logger.out(USAGE);
    return EXIT_OK;
  }
  const args = parseQueryArgs({ defaultLimit: DEFAULT_LIMIT, rest });
  if (args.errors.length > 0) {
    args.errors.forEach((e) => {
      deps.logger.error(e);
    });
    deps.logger.error(USAGE);
    return EXIT_USAGE;
  }
  const questionError = validateFactsQuestion({ question: args.question });
  if (questionError !== undefined) {
    deps.logger.error(questionError);
    deps.logger.error(USAGE);
    return EXIT_USAGE;
  }

  const home = args.home ?? deps.home();
  const nowMs = deps.nowMs();
  const corpus = deps.loadCorpus({
    home,
    nowIso: new Date(nowMs).toISOString(),
    ...(args.corpus !== undefined ? { corpus: args.corpus } : {}),
  });
  if (corpus.ok === false) {
    deps.logger.out("no corpus yet — run `slopweaver refresh` first");
    return EXIT_EXPECTED_EMPTY;
  }
  corpus.warnings.forEach((w) => {
    deps.logger.warn(w);
  });
  const records = corpus.value;
  const semantic = await deps.prepareSemantic({ home, question: args.question, records, semantic: args.semantic });

  const slice = deps.retrieveRecords({
    decay: decayParamsFromDays({ days: args.halfLifeDays, nowMs }),
    question: args.question,
    records,
    sliceLimit: args.limit,
    ...(semantic.context !== undefined ? { semantic: semantic.context } : {}),
    ...(args.alpha !== undefined ? { alpha: args.alpha } : {}),
  });
  for (const line of renderFactsLines({ slice })) {
    deps.logger.out(line);
  }
  return factsExitCode();
}

/** Production dependencies for {@link runFactsWithDeps}. */
function productionFactsDeps(): FactsDeps {
  return {
    home: slopweaverHome,
    loadCorpus,
    logger: {
      error: (m) => {
        logger.error(m);
      },
      out: (m) => {
        logger.out(m);
      },
      warn: (m) => {
        logger.warn(m);
      },
    },
    nowMs: () => Date.now(),
    prepareSemantic: prepareSemanticForQuery,
    retrieveRecords,
  };
}

/**
 * Run the facts verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runFacts(argv: readonly string[]): Promise<number> {
  return runFactsWithDeps({ argv, deps: productionFactsDeps() });
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
