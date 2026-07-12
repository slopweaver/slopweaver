/**
 * Serialise an `ask` answer to the one machine-readable JSON object the eval harness parses. Pure: no IO,
 * no `Date`, deterministic given its input. `retrievedRefs` is what lets the harness score retrieval
 * recall (did the right records get retrieved) apart from citation precision (did the answer cite them).
 */
import type { Answer } from '../../../retrieval/answerFromSlice.js'

export interface AskJson {
  readonly question: string
  readonly tldr: string
  readonly details: string | null
  readonly answer: string
  readonly citations: readonly string[]
  readonly citedTokens: readonly string[]
  readonly retrievedRefs: Answer['retrievedRefs']
  readonly retrieved: number
  readonly used: number
}

/**
 * Render the JSON payload for `ask --json`.
 *
 * @param question the question that was asked
 * @param answer the grounded answer produced by the ask engine
 * @returns a pretty-printed JSON string (the sole stdout line in `--json` mode)
 */
export function renderAskJson({ question, answer }: { question: string; answer: Answer }): string {
  const payload: AskJson = {
    question,
    tldr: answer.tldr,
    details: answer.details ?? null,
    answer: answer.answer,
    citations: answer.citations,
    citedTokens: answer.citedTokens,
    retrievedRefs: answer.retrievedRefs,
    retrieved: answer.retrieved,
    used: answer.used,
  }
  return JSON.stringify(payload, null, 2)
}
