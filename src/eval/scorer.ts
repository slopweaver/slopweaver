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
import { z } from 'zod'

/**
 * The four question classes the golden set spans, so a scoreboard can be read by class — each stresses
 * retrieval differently (a single fact, an aggregation across records, an old record recency decay
 * buries, a design thread cutting across PRs).
 */
export type QuestionClass = 'single-fact' | 'aggregation' | 'recency' | 'cross-cutting'

/** A hand-labelled golden case: a question and the corpus sourceIds that genuinely ground its answer. */
export interface GoldenCase {
  readonly question: string
  readonly kind: QuestionClass
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

/** Parse-edge schema: extra fields (on a ref or the whole payload) are stripped, matching the projection intent. */
const scorableAnswerSchema = z.object({
  retrievedRefs: z.array(z.object({ sourceId: z.string(), token: z.string() })),
  citedTokens: z.array(z.string()),
})

/**
 * Narrow an arbitrary parsed `ask --json` value to the fields the scorer needs, or null if the shape is
 * wrong. Keeps the unknown-parsing pure and testable, so the promptfoo assertion edge stays thin. Zod
 * strips the extra fields (e.g. a ref's `url`), reproducing the old projection exactly.
 *
 * @param value a JSON value (typically the provider's parsed stdout)
 * @returns the scorable projection, or null when `retrievedRefs`/`citedTokens` are missing or malformed
 */
export function parseScorableAnswer({ value }: { value: unknown }): ScorableAnswer | null {
  const parsed = scorableAnswerSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * The frozen golden set: 12 questions hand-labelled against the public Slopweaver corpus (its own repo),
 * three per class. Labels are chosen by READING the corpus — the specific record(s) that genuinely
 * answer each question — never from `ask`'s own output. Frozen so scores are comparable run to run.
 *
 * The `recency` cluster deliberately targets the oldest records (the May v1 roadmap comments); recency
 * decay tends to bury them below the slice, so these are where the completeness gap reproduces as a red
 * (low retrieval-recall) case — the proof the harness bites.
 */
export const GOLDEN_CASES: readonly GoldenCase[] = [
  // single-fact — one specific record holds the answer.
  {
    question: 'why does slopweaver use the node-modules linker instead of Yarn PnP?',
    kind: 'single-fact',
    expectedGrounding: ['#86:comment:1'],
  },
  {
    question: 'what does enabling persist on the vector cache do?',
    kind: 'single-fact',
    expectedGrounding: ['#89:comment:8'],
  },
  {
    question: 'how is the bronze refresh cursor computed?',
    kind: 'single-fact',
    expectedGrounding: ['#87:comment:3'],
  },
  // aggregation — a correct answer must rest on several records at once.
  {
    question: 'what shipped across the whole v0.1 release?',
    kind: 'aggregation',
    expectedGrounding: ['#86', '#87', '#88', '#89', '#90'],
  },
  {
    question: 'which pull requests built the retrieval and answering features?',
    kind: 'aggregation',
    expectedGrounding: ['#88', '#89'],
  },
  {
    question: 'what were the main stability issues review flagged and fixed across the v0.1 PRs?',
    kind: 'aggregation',
    expectedGrounding: ['#87:comment:8', '#88:comment:8', '#88:comment:10', '#89:comment:9', '#89:comment:10'],
  },
  // recency — the answer lives in an OLD record; recency decay is the adversary here.
  {
    question: 'what was the earliest roadmap amendment discussed on the project?',
    kind: 'recency',
    expectedGrounding: ['#2:comment:0'],
  },
  {
    question: 'what did the mid-May project status snapshot report?',
    kind: 'recency',
    expectedGrounding: ['#2:comment:1'],
  },
  {
    question: 'what was the first dogfooding milestone the project reached?',
    kind: 'recency',
    expectedGrounding: ['#2:comment:2'],
  },
  // cross-cutting — one design thread that runs through several PRs.
  {
    question: 'how does slopweaver keep private identifiers out of the public repo?',
    kind: 'cross-cutting',
    expectedGrounding: ['#86:comment:4', '#87:comment:1'],
  },
  {
    question: 'how does the pipeline avoid recomputing records that have not changed?',
    kind: 'cross-cutting',
    expectedGrounding: ['#87:comment:4', '#88:comment:2', '#89:comment:2'],
  },
  {
    question: 'what keeps the language-model and embedding cost down?',
    kind: 'cross-cutting',
    expectedGrounding: ['#88:comment:2', '#89:comment:8'],
  },
]
