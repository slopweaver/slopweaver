/**
 * Aggregates per-case grounding scores across repetitions into a baseline scoreboard. Pure: the
 * effectful runner shells `ask --json` N times per case and hands the scores here.
 *
 * The two layers are aggregated differently, matching how they behave: retrieval recall is DETERMINISTIC
 * (fixed corpus + fixed query ⇒ the same slice every run), so it is reported as a single number with a
 * stability flag; answer recall + citation precision are STOCHASTIC (the model picks what to cite), so
 * they are reported as a median over the reps with the observed [min–max] range.
 */
import type { GroundingScore, QuestionClass } from './scorer.js'

/** Median of a non-empty list of numbers (mean of the two middle values when the count is even). */
export function median({ values }: { values: readonly number[] }): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** A stochastic metric summarised over reps: its median and the spread actually observed. */
export interface RangeStat {
  readonly median: number
  readonly min: number
  readonly max: number
}

/** One case's baseline: deterministic retrieval recall + the stochastic answer-level metrics over reps. */
export interface CaseAggregate {
  readonly question: string
  readonly kind: QuestionClass
  readonly reps: number
  readonly expectedCount: number
  /** Deterministic: the slice is fixed, so every rep agrees (unless `retrievalStable` is false). */
  readonly retrievalRecall: number
  /** False if the reps disagreed on retrieval recall — a red flag the corpus/query was not stable. */
  readonly retrievalStable: boolean
  readonly answerRecall: RangeStat
  readonly citationPrecision: RangeStat
}

/** Summarise a stochastic metric's values across reps. */
function rangeStat({ values }: { values: readonly number[] }): RangeStat {
  return { median: median({ values }), min: Math.min(...values), max: Math.max(...values) }
}

/**
 * Fold one case's per-rep scores into a single row. Retrieval recall is taken from the first rep and
 * checked for agreement across the rest (it should never vary); answer-level metrics are summarised as
 * median + range.
 *
 * @param question the case question
 * @param kind the case's question class
 * @param scores one GroundingScore per repetition (at least one)
 * @returns the aggregated row for the scoreboard
 */
export function aggregateCase({
  question,
  kind,
  scores,
}: {
  question: string
  kind: QuestionClass
  scores: readonly GroundingScore[]
}): CaseAggregate {
  const retrievalValues = scores.map((score) => score.retrievalRecall)
  return {
    question,
    kind,
    reps: scores.length,
    expectedCount: scores[0]!.expectedCount,
    retrievalRecall: retrievalValues[0]!,
    retrievalStable: retrievalValues.every((value) => value === retrievalValues[0]),
    answerRecall: rangeStat({ values: scores.map((score) => score.answerRecall) }),
    citationPrecision: rangeStat({ values: scores.map((score) => score.citationPrecision) }),
  }
}

/** Whole-percent string for a 0–1 ratio. */
function pct({ ratio }: { ratio: number }): string {
  return `${Math.round(ratio * 100)}%`
}

/** A stochastic metric as `median [min–max]`, collapsing to a single value when it never varied. */
function pctRange({ stat }: { stat: RangeStat }): string {
  if (stat.min === stat.max) {
    return pct({ ratio: stat.median })
  }
  return `${pct({ ratio: stat.median })} [${pct({ ratio: stat.min })}–${pct({ ratio: stat.max })}]`
}

/** The red/green driver: a case is red when a MINORITY of its labelled records reached the slice. */
const RETRIEVAL_RED_BELOW = 0.5

/**
 * Render the baseline scoreboard as GitHub-flavoured markdown — metrics only, NO answer text, so it is
 * always safe to commit to the public repo. Cases keep their given order (grouped by class). A summary
 * line reports the mean retrieval recall overall and the count of red cases.
 *
 * @param rows the aggregated per-case rows, in display order
 * @returns the scoreboard markdown
 */
export function renderScoreboard({ rows }: { rows: readonly CaseAggregate[] }): string {
  const reps = rows[0]?.reps ?? 0
  const meanRetrieval = rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + row.retrievalRecall, 0) / rows.length
  const reds = rows.filter((row) => row.retrievalRecall < RETRIEVAL_RED_BELOW)

  const lines: string[] = []
  lines.push(`**Mean retrieval recall@k: ${pct({ ratio: meanRetrieval })}** across ${String(rows.length)} cases`
    + ` · ${String(reds.length)} red (retrieval recall < ${pct({ ratio: RETRIEVAL_RED_BELOW })})`
    + ` · answer-level metrics over ${String(reps)} reps (median [min–max]).`)
  lines.push('')
  lines.push('| | Class | Question | Retrieval recall@k | Answer recall | Citation precision |')
  lines.push('|---|---|---|---|---|---|')
  for (const row of rows) {
    const flag = row.retrievalRecall < RETRIEVAL_RED_BELOW ? '🔴' : '🟢'
    const retrieval = `${pct({ ratio: row.retrievalRecall })} (${String(Math.round(row.retrievalRecall * row.expectedCount))}/${String(row.expectedCount)})`
      + (row.retrievalStable ? '' : ' ⚠️unstable')
    lines.push(`| ${flag} | ${row.kind} | ${row.question} | ${retrieval} | ${pctRange({ stat: row.answerRecall })} | ${pctRange({ stat: row.citationPrecision })} |`)
  }
  return lines.join('\n')
}
