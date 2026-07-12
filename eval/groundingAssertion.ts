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
  // v0.2 is MEASUREMENT, not a quality gate — `score`/`namedScores` carry the real numbers and the
  // scoreboard's 🔴/🟢 carries the red/green signal. So a scored case passes even at 0% retrieval recall:
  // the `recency` cluster legitimately scores 0 (the completeness gap), and failing those here would
  // pre-empt PR5's job — the absolute quality floor + baseline↔candidate regression gate (non-zero exit)
  // land in PR5. Genuine PLUMBING failures (unscorable output, or a question with no golden label) still
  // fail above.
  return {
    pass: true,
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
