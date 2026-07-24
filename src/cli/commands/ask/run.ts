/**
 * `slopweaver ask` — answer a question from the local world model. Loads bronze + gold, retrieves a
 * ranked slice (hybrid BM25⊕cosine, fail-soft to BM25), and composes a grounded, cited answer via the
 * keyless `claude` transport. `--no-semantic` forces BM25-only (skips the embedder).
 *
 * A thin effectful shell: every pure decision (validation, rendering, exit codes) comes from
 * {@link ../query/core}; the corpus load, semantic prep, LLM call, and logging are INJECTED via
 * {@link runAskWithDeps}, so the branch behaviour is unit-tested with plain fakes. `runAsk(argv)` wires the
 * production dependencies.
 */

import { slopweaverHome } from "../../../config.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { logger } from "../../../lib/logger.js";
import type { Result } from "../../../lib/result.js";
import { claudeCliClient } from "../../../llm/claudeCli.js";
import type { LlmClient } from "../../../llm/provider.js";
import { type Answer } from "../../../retrieval/answerFromSlice.js";
import { answerQuestion } from "../../../retrieval/askEngine.js";
import { loadCorpus } from "../../../retrieval/loadCorpus.js";
import type { OwnerIdentity } from "../../../retrieval/ownerScope.js";
import type { SemanticPreparation } from "../../../retrieval/semanticRetrieval.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { askExitCode, renderAskTextLines, validateAskQuestion } from "../query/core.js";
import { loadOwnerContext } from "../query/ownerContext.js";
import { planQueryRetrieval } from "../query/retrievalPlan.js";
import { prepareSemanticForQuery } from "../query/shell.js";
import { parseQueryArgs } from "../queryArgs.js";
import { renderAskJson } from "./askJson.js";

const USAGE =
  "usage: slopweaver ask <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--json] [--home <dir>] [--corpus <dir>]";
const DEFAULT_LIMIT = 12;

/** The injectable effectful seams the `ask` shell composes (fakes in tests, production wiring in {@link runAsk}). */
export interface AskDeps {
  readonly home: () => string;
  readonly nowMs: () => number;
  readonly loadCorpus: (args: { home: string; corpus?: string; nowIso: string }) => Result<readonly CorpusRecord[]>;
  readonly prepareSemantic: (args: {
    home: string;
    question: string;
    records: readonly CorpusRecord[];
    semantic: boolean;
  }) => Promise<SemanticPreparation>;
  /** Resolve the owner's cross-source identity (PR4.5) — `{ owner: undefined }` disables the owner lens. */
  readonly ownerContext: (args: { home: string; records: readonly CorpusRecord[] }) => {
    owner: OwnerIdentity | undefined;
  };
  readonly answerQuestion: typeof answerQuestion;
  readonly client: LlmClient;
  readonly logger: { out: (m: string) => void; warn: (m: string) => void; error: (m: string) => void };
}

/**
 * Run the ask verb over injected dependencies — the testable shell.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @param deps the effectful seams
 * @returns the process exit code
 */
export async function runAskWithDeps({ argv, deps }: { argv: readonly string[]; deps: AskDeps }): Promise<number> {
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
  const questionError = validateAskQuestion({ question: args.question });
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
  const plan = await planQueryRetrieval({
    halfLifeDays: args.halfLifeDays,
    home,
    nowMs,
    ownerContext: deps.ownerContext,
    prepareSemantic: deps.prepareSemantic,
    question: args.question,
    records: corpus.value,
    semantic: args.semantic,
  });
  const answer = await deps.answerQuestion({
    client: deps.client,
    question: args.question,
    records: plan.records,
    retrievalQuery: plan.query,
    sliceLimit: args.limit,
    ...(plan.decay !== undefined ? { decay: plan.decay } : {}),
    ...(plan.semantic.context !== undefined ? { semantic: plan.semantic.context } : {}),
    ...(args.alpha !== undefined ? { alpha: args.alpha } : {}),
  });
  return emitAnswer({ answer, deps, json: args.json, question: args.question });
}

/** Emit the answer engine's result: log every error + exit error, or render the answer. Thin. */
function emitAnswer({
  answer,
  deps,
  json,
  question,
}: {
  answer: Result<Answer>;
  deps: AskDeps;
  json: boolean;
  question: string;
}): number {
  if (answer.ok === false) {
    answer.errors.forEach((e) => {
      deps.logger.error(e);
    });
    return EXIT_ERROR;
  }
  return renderAskResult({ answer: answer.value, json, out: deps.logger.out, question });
}

/** Emit the answer (JSON or pretty) and return the exit code. Thin — the lines come from the pure core. */
function renderAskResult({
  answer,
  json,
  question,
  out,
}: {
  answer: Answer;
  json: boolean;
  question: string;
  out: (m: string) => void;
}): number {
  if (json) {
    out(renderAskJson({ answer, question }));
  } else {
    for (const line of renderAskTextLines({ answer })) {
      out(line);
    }
  }
  return askExitCode({ retrieved: answer.retrieved });
}

/** Production dependencies for {@link runAskWithDeps}. */
function productionAskDeps(): AskDeps {
  return {
    answerQuestion,
    client: claudeCliClient(),
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
    ownerContext: loadOwnerContext,
    prepareSemantic: prepareSemanticForQuery,
  };
}

/**
 * Run the ask verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runAsk(argv: readonly string[]): Promise<number> {
  return runAskWithDeps({ argv, deps: productionAskDeps() });
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
