/**
 * The deterministic ground-truth scorer for the Slopweaver eval harness. Pure, no LLM: it grades an
 * `ask --json` result against a hand-labelled, frozen expected-grounding set WE own, so the gate can
 * never drift toward the retriever's own opinion of what is relevant (the circular-grading hole).
 *
 * Two layers, kept distinct — because a red case is only actionable when you know WHERE it failed:
 *  - retrieval recall — did the expected records reach the candidate slice at all? A miss here is the
 *    RETRIEVER dropping a record before grounding ever saw it.
 *  - answer recall + citation precision — of the expected records, how many did the answer cite, and of
 *    the records it cited, how many were right? A miss here WITH a slice hit is the LLM having the
 *    record and not using it.
 */
import { isRecord } from '../lib/parsers.js'

/** A hand-labelled golden case: a question and the corpus sourceIds that genuinely ground its answer. */
export interface GoldenCase {
  readonly question: string
  /** The sourceIds a correct answer must be grounded by — labelled by us and frozen, never from `ask`. */
  readonly expectedGrounding: readonly string[]
}

/** The slice of an `ask --json` result the scorer reads (a structural subset — extra fields are ignored). */
export interface ScorableAnswer {
  /** Every record in the retrieved slice, in the id spaces a label may match against. */
  readonly retrievedRefs: readonly { readonly sourceId: string; readonly token: string }[]
  /** The tokens the answer actually cited. */
  readonly citedTokens: readonly string[]
}

/** The two-layer grounding score plus the raw counts, so a number on a scoreboard is always explainable. */
export interface GroundingScore {
  /** `|expected ∩ slice| / |expected|` — did the retriever surface the expected records. */
  readonly retrievalRecall: number
  /**
   * `|expected ∩ cited| / |expected|` — did the answer cite the expected records. CAN exceed
   * `retrievalRecall`: the answer may legitimately cite a record via a gold digest that MENTIONS it
   * (grounded by the digest, not by the record's own retrieval), so it is cited without being
   * individually retrieved. That asymmetry is a signal, not an error — see `scoreGrounding`.
   */
  readonly answerRecall: number
  /** `|expected ∩ cited| / |cited|` — of what it cited, how much was right (1 when nothing was cited). */
  readonly citationPrecision: number
  readonly expectedCount: number
  readonly retrievedHits: number
  readonly citedHits: number
  readonly citedCount: number
}

/**
 * Grade one answer against one case's expected grounding. Cited tokens are resolved to their sourceIds
 * via the slice they came from (a citation can only name a token the slice offered), so all three
 * metrics compare like-for-like in sourceId space.
 *
 * @param expectedGrounding the frozen, hand-labelled sourceIds a correct answer must rest on
 * @param answer the retrieved slice + cited tokens from an `ask --json` result
 * @returns the two-layer grounding score with its underlying counts
 */
export function scoreGrounding({
  expectedGrounding,
  answer,
}: {
  expectedGrounding: readonly string[]
  answer: ScorableAnswer
}): GroundingScore {
  const expected = new Set(expectedGrounding)
  const retrievedSourceIds = new Set(answer.retrievedRefs.map((ref) => ref.sourceId))
  // Resolve each cited token to its record's sourceId. When the token names a retrieved record, use its
  // sourceId. Otherwise keep the token itself — this is the DELIBERATE cited-by-mention case: `ask` lets
  // an answer cite a record a gold digest MENTIONS (grounded by the digest, not the record's own
  // retrieval), so it is legitimately cited without appearing in the slice. Hence answer recall can
  // exceed retrieval recall; the deterministic gate (retrieval recall) is unaffected, as it counts only
  // records that actually reached the slice.
  const tokenToSourceId = new Map(answer.retrievedRefs.map((ref) => [ref.token, ref.sourceId]))
  const citedSourceIds = new Set(answer.citedTokens.map((token) => tokenToSourceId.get(token) ?? token))

  const retrievedHits = [...expected].filter((id) => retrievedSourceIds.has(id)).length
  const citedHits = [...expected].filter((id) => citedSourceIds.has(id)).length
  const expectedCount = expected.size
  const citedCount = citedSourceIds.size

  return {
    // An empty label is vacuously fully covered; a real case always labels at least one record.
    retrievalRecall: expectedCount === 0 ? 1 : retrievedHits / expectedCount,
    answerRecall: expectedCount === 0 ? 1 : citedHits / expectedCount,
    // No citations ⇒ no wrong citations ⇒ vacuously precise (1). answerRecall (0 here) is what flags
    // an answer that cited nothing, so precision stays a clean "of what was cited, how much was right".
    citationPrecision: citedCount === 0 ? 1 : citedHits / citedCount,
    expectedCount,
    retrievedHits,
    citedHits,
    citedCount,
  }
}

/**
 * Narrow an arbitrary parsed `ask --json` value to the fields the scorer needs, or null if the shape is
 * wrong. Keeps the unknown-parsing pure and testable, so the promptfoo assertion edge stays thin.
 *
 * @param value a JSON value (typically the provider's parsed stdout)
 * @returns the scorable projection, or null when `retrievedRefs`/`citedTokens` are missing or malformed
 */
export function parseScorableAnswer({ value }: { value: unknown }): ScorableAnswer | null {
  if (!isRecord(value)) {
    return null
  }
  const { retrievedRefs, citedTokens } = value
  if (!Array.isArray(retrievedRefs) || !Array.isArray(citedTokens)) {
    return null
  }
  const refs: { sourceId: string; token: string }[] = []
  for (const ref of retrievedRefs) {
    if (!isRecord(ref) || typeof ref.sourceId !== 'string' || typeof ref.token !== 'string') {
      return null
    }
    refs.push({ sourceId: ref.sourceId, token: ref.token })
  }
  if (!citedTokens.every((token): token is string => typeof token === 'string')) {
    return null
  }
  return { retrievedRefs: refs, citedTokens }
}

/**
 * The frozen golden set. v0.2 PR2 ships ONE labelled case to prove the scorer end to end; PR3 grows this
 * to 12 across the four question classes. Labels are chosen by inspecting the corpus, never from `ask`.
 *
 * `what changed recently?` → the substantive recent work is the v0.1 PRs #87–#90 (the bronze→silver→
 * gold→ask pipeline), plus the gold digest that summarises them.
 */
export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    question: 'what changed recently?',
    expectedGrounding: ['gold:by-source/github.md#slopweaver-slopweaver', '#90', '#89', '#88', '#87'],
  },
]
