/**
 * `slopweaver ask` — answer a question from the local world model. Loads bronze + gold, retrieves a
 * ranked slice (hybrid BM25⊕cosine, fail-soft to BM25), and composes a grounded, cited answer via the
 * keyless `claude` transport. `--no-semantic` forces BM25-only (skips the embedder).
 */
import { logger } from '../../../lib/logger.js'
import { defineCommand } from '../../defineCommand.js'
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from '../../exitCodes.js'
import { slopweaverHome } from '../../../config.js'
import { cacheDir } from '../../../corpus/corpusPaths.js'
import { claudeCliClient } from '../../../llm/claudeCli.js'
import { defaultEmbedder } from '../../../retrieval/embeddings.js'
import { diskVectorCacheStore } from '../../../retrieval/vectorCacheStore.js'
import { decayParamsFromDays } from '../../../retrieval/recencyDecay.js'
import { prepareSemanticContext } from '../../../retrieval/semanticRetrieval.js'
import { answerQuestion } from '../../../retrieval/askEngine.js'
import { loadCorpus } from '../../../retrieval/loadCorpus.js'
import { parseQueryArgs } from '../queryArgs.js'
import { renderAskJson } from './askJson.js'

const USAGE = 'usage: slopweaver ask <question> [--limit N] [--no-semantic] [--alpha 0..1] [--half-life-days N] [--json] [--home <dir>] [--corpus <dir>]'
const DEFAULT_LIMIT = 12

/**
 * Run the ask verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runAsk(argv: readonly string[]): Promise<number> {
  const rest = argv.slice(3)
  if (rest.includes('--help') || rest.includes('-h')) {
    logger.out(USAGE)
    return EXIT_OK
  }
  const args = parseQueryArgs({ rest, defaultLimit: DEFAULT_LIMIT })
  if (args.errors.length > 0) {
    args.errors.forEach((e) => { logger.error(e) })
    logger.error(USAGE)
    return EXIT_USAGE
  }
  if (args.question.trim().length === 0) {
    logger.error('ask needs a question')
    logger.error(USAGE)
    return EXIT_USAGE
  }

  const home = args.home ?? slopweaverHome()
  const nowMs = Date.now()
  const corpus = loadCorpus({ home, ...(args.corpus !== undefined ? { corpus: args.corpus } : {}), nowIso: new Date(nowMs).toISOString() })
  if (corpus.ok === false) {
    logger.out('no corpus yet — run `slopweaver refresh` first')
    return EXIT_EXPECTED_EMPTY
  }
  corpus.warnings.forEach((w) => { logger.warn(w) })
  const records = corpus.value

  const semanticPrep = args.semantic
    ? await prepareSemanticContext({
      records,
      query: args.question,
      deps: { embedder: defaultEmbedder, store: diskVectorCacheStore({ cacheDir: cacheDir({ home }) }) },
      enabled: true,
      warn: (m) => { logger.warn(m) },
    })
    : { degraded: false as const }

  const answer = await answerQuestion({
    question: args.question,
    client: claudeCliClient(),
    records,
    sliceLimit: args.limit,
    decay: decayParamsFromDays({ days: args.halfLifeDays, nowMs }),
    ...(semanticPrep.context !== undefined ? { semantic: semanticPrep.context } : {}),
    ...(args.alpha !== undefined ? { alpha: args.alpha } : {}),
  })
  if (answer.ok === false) {
    answer.errors.forEach((e) => { logger.error(e) })
    return EXIT_ERROR
  }

  // `--json`: one machine-readable object on stdout (diagnostics stay on stderr), for the eval harness.
  if (args.json) {
    logger.out(renderAskJson({ question: args.question, answer: answer.value }))
    return answer.value.retrieved > 0 ? EXIT_OK : EXIT_EXPECTED_EMPTY
  }

  const { tldr, details, citations, retrieved } = answer.value
  logger.out(tldr)
  if (details !== undefined && details.length > 0) {
    logger.out('')
    logger.out(details)
  }
  if (citations.length > 0) {
    logger.out('')
    logger.out('citations:')
    citations.forEach((c) => { logger.out(`  ${c}`) })
  }
  // Expected-empty ONLY when the query retrieved nothing — a substantive answer with no surviving
  // citations is still a real answer (exit 0), not "nothing matched".
  return retrieved > 0 ? EXIT_OK : EXIT_EXPECTED_EMPTY
}

export const askRunCommand = defineCommand({
  summary: 'Ask a grounded question of your local world model',
  usage: USAGE,
  example: 'slopweaver ask "what changed in the refresh pipeline?"',
  effect: 'local-state',
  requiresApproval: false,
  createsWorkItem: false,
  doorRouted: false,
  dryParseSafe: false,
  parseRejectIsIoFree: false,
  diagnostic: false,
  run: runAsk,
})
