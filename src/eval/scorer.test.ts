import { describe, expect, it } from 'vitest'
import { GOLDEN_CASES, parseScorableAnswer, scoreGrounding, type ScorableAnswer } from './scorer.js'

describe('scoreGrounding', () => {
  it('scores a perfect answer 1/1/1 across all three layers', () => {
    const answer: ScorableAnswer = {
      retrievedRefs: [
        { sourceId: '#87', token: '#87' },
        { sourceId: '#88', token: '#88' },
        { sourceId: '#99', token: '#99' },
      ],
      citedTokens: ['#87', '#88'],
    }
    const score = scoreGrounding({ expectedGrounding: ['#87', '#88'], answer })
    expect(score.retrievalRecall).toBe(1)
    expect(score.answerRecall).toBe(1)
    expect(score.citationPrecision).toBe(1)
    expect(score.expectedCount).toBe(2)
    expect(score.retrievedHits).toBe(2)
    expect(score.citedHits).toBe(2)
    expect(score.citedCount).toBe(2)
  })

  it('separates a retrieval miss (recall < 1) from a slice-hit-but-uncited record (answer recall < 1)', () => {
    // #89 never reaches the slice (retriever miss); #88 and gold reach it but the answer only cites #87.
    const answer: ScorableAnswer = {
      retrievedRefs: [
        { sourceId: '#87', token: '#87' },
        { sourceId: '#88', token: '#88' },
        { sourceId: 'gold:x', token: 'gold:x' },
      ],
      citedTokens: ['#87'],
    }
    const score = scoreGrounding({ expectedGrounding: ['#87', '#88', '#89', 'gold:x'], answer })
    expect(score.retrievalRecall).toBe(0.75) // {#87,#88,gold:x} of 4 reached the slice
    expect(score.answerRecall).toBe(0.25) // only #87 of 4 was cited
    expect(score.citationPrecision).toBe(1) // the one thing cited was expected
    expect(score.retrievedHits).toBe(3)
    expect(score.citedHits).toBe(1)
  })

  it('drops citation precision when the answer cites a record that is not expected', () => {
    const answer: ScorableAnswer = {
      retrievedRefs: [
        { sourceId: '#87', token: '#87' },
        { sourceId: '#88', token: '#88' },
      ],
      citedTokens: ['#87', '#88'],
    }
    const score = scoreGrounding({ expectedGrounding: ['#87'], answer })
    expect(score.retrievalRecall).toBe(1)
    expect(score.answerRecall).toBe(1)
    expect(score.citationPrecision).toBe(0.5) // cited 2, only #87 was right
    expect(score.citedCount).toBe(2)
    expect(score.citedHits).toBe(1)
  })

  it('treats an answer that cited nothing as recall 0, precision vacuously 1', () => {
    const answer: ScorableAnswer = { retrievedRefs: [{ sourceId: '#87', token: '#87' }], citedTokens: [] }
    const score = scoreGrounding({ expectedGrounding: ['#87'], answer })
    expect(score.retrievalRecall).toBe(1)
    expect(score.answerRecall).toBe(0)
    expect(score.citationPrecision).toBe(1)
    expect(score.citedCount).toBe(0)
  })

  it('resolves a cited token to its sourceId via the slice, so metrics compare in sourceId space', () => {
    // The token the answer cites ('T1') differs from the record's sourceId ('S1'); the map bridges them.
    const answer: ScorableAnswer = { retrievedRefs: [{ sourceId: 'S1', token: 'T1' }], citedTokens: ['T1'] }
    const score = scoreGrounding({ expectedGrounding: ['S1'], answer })
    expect(score.answerRecall).toBe(1)
    expect(score.citationPrecision).toBe(1)
    expect(score.citedHits).toBe(1)
  })

  it('lets answer recall exceed retrieval recall for records cited via a digest mention', () => {
    // Only the gold digest reached the slice; the answer cites #88 and #89 (grounded by the digest that
    // mentions them), though neither PR's own record was retrieved. Retrieval recall must NOT count them
    // (their records never reached the slice); answer recall MUST (the answer did cite them).
    const answer: ScorableAnswer = {
      retrievedRefs: [{ sourceId: 'gold:d', token: 'gold:d' }],
      citedTokens: ['#88', '#89'],
    }
    const score = scoreGrounding({ expectedGrounding: ['#88', '#89'], answer })
    expect(score.retrievalRecall).toBe(0)
    expect(score.answerRecall).toBe(1)
    expect(score.citationPrecision).toBe(1)
    expect(score.retrievedHits).toBe(0)
    expect(score.citedHits).toBe(2)
  })

  it('is vacuously fully covered when the label is empty', () => {
    const answer: ScorableAnswer = { retrievedRefs: [{ sourceId: '#1', token: '#1' }], citedTokens: ['#1'] }
    const score = scoreGrounding({ expectedGrounding: [], answer })
    expect(score.retrievalRecall).toBe(1)
    expect(score.answerRecall).toBe(1)
    expect(score.citationPrecision).toBe(0) // cited #1 but nothing was expected → a false positive
    expect(score.expectedCount).toBe(0)
  })
})

describe('parseScorableAnswer', () => {
  it('projects the scorable fields and ignores the rest', () => {
    const value = {
      question: 'q',
      tldr: 't',
      citations: ['u'],
      citedTokens: ['#1'],
      retrievedRefs: [{ sourceId: '#1', token: '#1', url: 'https://x/1' }],
      retrieved: 1,
    }
    expect(parseScorableAnswer({ value })).toEqual({
      retrievedRefs: [{ sourceId: '#1', token: '#1' }],
      citedTokens: ['#1'],
    })
  })

  it('returns null for a non-object value', () => {
    expect(parseScorableAnswer({ value: 42 })).toBe(null)
  })

  it('returns null when citedTokens is missing', () => {
    expect(parseScorableAnswer({ value: { retrievedRefs: [] } })).toBe(null)
  })

  it('returns null when a retrieved ref lacks a token', () => {
    expect(parseScorableAnswer({ value: { retrievedRefs: [{ sourceId: '#1' }], citedTokens: [] } })).toBe(null)
  })

  it('returns null when a cited token is not a string', () => {
    expect(parseScorableAnswer({ value: { retrievedRefs: [], citedTokens: [1] } })).toBe(null)
  })
})

describe('GOLDEN_CASES', () => {
  it('ships exactly one labelled case for PR2, grounded on the recent PRs + the gold digest', () => {
    expect(GOLDEN_CASES).toHaveLength(1)
    expect(GOLDEN_CASES[0]!.question).toBe('what changed recently?')
    expect(GOLDEN_CASES[0]!.expectedGrounding).toEqual([
      'gold:by-source/github.md#slopweaver-slopweaver',
      '#90',
      '#89',
      '#88',
      '#87',
    ])
  })
})
