/**
 * promptfoo custom assertion: the deterministic ground-truth gate. It reads the real `ask --json` result
 * this test produced and looks up the frozen expected-grounding label by question, then scores them with
 * the pure `scoreGrounding` — NO model in the loop, so the gate can never drift from the labels WE own.
 *
 * `(output, context)` is promptfoo's fixed assertion signature, so it stays positional (the framework
 * exception to the named-object-params rule; `askProvider.ts`'s `callApi` is the same). All three metrics
 * surface as namedScores; the headline `retrievalRecall` is the pass/score, matching the plan's
 * "recall@k is the gate" call. The label is resolved from GOLDEN_CASES (single source of truth) via the
 * question, so it can never be fed the retriever's own opinion of what is relevant.
 */
import { GOLDEN_CASES, parseScorableAnswer, scoreGrounding } from '../src/eval/scorer.js'

interface AssertionContext {
  readonly vars: Record<string, unknown>
  readonly providerResponse?: { readonly output?: unknown }
}

interface GradingResult {
  readonly pass: boolean
  readonly score: number
  readonly reason: string
  readonly namedScores: Record<string, number>
}

export default function groundingAssertion(output: string, context: AssertionContext): GradingResult {
  let raw: unknown = context.providerResponse?.output
  if (raw === undefined || raw === '') {
    try {
      raw = JSON.parse(output)
    } catch {
      raw = null
    }
  }
  const answer = parseScorableAnswer({ value: raw })
  if (answer === null) {
    return {
      pass: false,
      score: 0,
      reason: 'ask --json output was not scorable (missing/malformed retrievedRefs or citedTokens)',
      namedScores: {},
    }
  }

  const question = typeof context.vars.question === 'string' ? context.vars.question : ''
  const labelled = GOLDEN_CASES.find((golden) => golden.question === question)
  if (labelled === undefined) {
    return { pass: false, score: 0, reason: `no golden label for question: ${question}`, namedScores: {} }
  }

  const score = scoreGrounding({ expectedGrounding: labelled.expectedGrounding, answer })
  // v0.2 PR2 is measurement, not a quality gate — `score`/`namedScores` carry the real numbers for the
  // scoreboard, and the pass here is only a PLUMBING smoke check: at least one labelled record reached
  // the slice, so the label and the corpus share an id space (a 0 would mean a mis-labelled/disjoint
  // set, not merely weak retrieval). The absolute quality floor + baseline↔candidate regression gate
  // (non-zero exit) land in PR5.
  return {
    pass: score.retrievedHits > 0,
    score: score.retrievalRecall,
    reason: [
      `retrieval recall ${pct({ ratio: score.retrievalRecall })} (${score.retrievedHits}/${score.expectedCount})`,
      `answer recall ${pct({ ratio: score.answerRecall })} (${score.citedHits}/${score.expectedCount})`,
      `citation precision ${pct({ ratio: score.citationPrecision })} (${score.citedHits}/${score.citedCount})`,
    ].join(' · '),
    namedScores: {
      retrievalRecall: score.retrievalRecall,
      answerRecall: score.answerRecall,
      citationPrecision: score.citationPrecision,
    },
  }
}

/** Format a 0–1 ratio as a whole-percent string for the human-readable reason line. */
function pct({ ratio }: { ratio: number }): string {
  return `${(ratio * 100).toFixed(0)}%`
}
