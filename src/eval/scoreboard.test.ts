import { describe, expect, it } from 'vitest'
import { aggregateCase, median, renderScoreboard, type CaseAggregate } from './scoreboard.js'
import type { GroundingScore } from './scorer.js'

/** Build a GroundingScore with only the fields a test cares about; the rest are consistent filler. */
function score({
  retrievalRecall,
  answerRecall,
  citationPrecision,
  expectedCount,
}: {
  retrievalRecall: number
  answerRecall: number
  citationPrecision: number
  expectedCount: number
}): GroundingScore {
  return {
    retrievalRecall,
    answerRecall,
    citationPrecision,
    expectedCount,
    retrievedHits: Math.round(retrievalRecall * expectedCount),
    citedHits: Math.round(answerRecall * expectedCount),
    citedCount: 1,
  }
}

describe('median', () => {
  it('returns the middle value for an odd count', () => {
    expect(median({ values: [0.6, 0.2, 0.4] })).toBe(0.4)
  })

  it('averages the two middle values for an even count', () => {
    expect(median({ values: [0.2, 0.4, 0.6, 0.8] })).toBe(0.5)
  })

  it('returns the sole value for a single rep', () => {
    expect(median({ values: [0.2] })).toBe(0.2)
  })
})

describe('aggregateCase', () => {
  it('takes deterministic retrieval recall from the reps and summarises answer-level as median + range', () => {
    const scores: GroundingScore[] = [
      score({ retrievalRecall: 0.2, answerRecall: 0.2, citationPrecision: 0.5, expectedCount: 5 }),
      score({ retrievalRecall: 0.2, answerRecall: 0.6, citationPrecision: 0.5, expectedCount: 5 }),
      score({ retrievalRecall: 0.2, answerRecall: 0.4, citationPrecision: 0.5, expectedCount: 5 }),
    ]
    const agg = aggregateCase({ question: 'q', kind: 'aggregation', scores })
    expect(agg.reps).toBe(3)
    expect(agg.expectedCount).toBe(5)
    expect(agg.retrievalRecall).toBe(0.2)
    expect(agg.retrievalStable).toBe(true)
    expect(agg.answerRecall).toEqual({ median: 0.4, min: 0.2, max: 0.6 })
    expect(agg.citationPrecision).toEqual({ median: 0.5, min: 0.5, max: 0.5 })
  })

  it('flags retrieval as unstable when the reps disagree', () => {
    const scores: GroundingScore[] = [
      score({ retrievalRecall: 0.2, answerRecall: 0.2, citationPrecision: 0.5, expectedCount: 5 }),
      score({ retrievalRecall: 0.4, answerRecall: 0.2, citationPrecision: 0.5, expectedCount: 5 }),
    ]
    const agg = aggregateCase({ question: 'q', kind: 'recency', scores })
    expect(agg.retrievalStable).toBe(false)
    expect(agg.retrievalRecall).toBe(0.2)
  })
})

describe('renderScoreboard', () => {
  const rows: CaseAggregate[] = [
    {
      question: 'q1',
      kind: 'single-fact',
      reps: 3,
      expectedCount: 1,
      retrievalRecall: 0,
      retrievalStable: true,
      answerRecall: { median: 0, min: 0, max: 0 },
      citationPrecision: { median: 1, min: 1, max: 1 },
    },
    {
      question: 'q2',
      kind: 'aggregation',
      reps: 3,
      expectedCount: 5,
      retrievalRecall: 0.8,
      retrievalStable: true,
      answerRecall: { median: 0.6, min: 0.4, max: 0.8 },
      citationPrecision: { median: 0.5, min: 0.5, max: 0.5 },
    },
  ]

  it('renders a summary line with mean retrieval recall and the red count', () => {
    const lines = renderScoreboard({ rows }).split('\n')
    expect(lines[0]).toBe(
      '**Mean retrieval recall@k: 40%** across 2 cases · 1 red (retrieval recall < 50%) · answer-level metrics over 3 reps (median [min–max]).',
    )
  })

  it('marks a low-recall case red and a high-recall case green, collapsing a zero-spread range', () => {
    const lines = renderScoreboard({ rows }).split('\n')
    expect(lines[4]).toBe('| 🔴 | single-fact | q1 | 0% (0/1) | 0% | 100% |')
    expect(lines[5]).toBe('| 🟢 | aggregation | q2 | 80% (4/5) | 60% [40%–80%] | 50% |')
  })
})
