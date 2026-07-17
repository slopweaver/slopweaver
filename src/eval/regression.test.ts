import { describe, expect, it } from 'vitest'

import {
  baselinePath,
  compareToBaseline,
  fixturePath,
  loadBaseline,
  loadFixtureRecords,
  scoreRecall,
  type RecallBaseline,
  type RecallScore,
} from './regression.js'

/** A synthetic baseline for the pure comparison cases (floors chosen to exercise each branch). */
const baseline: RecallBaseline = {
  schemaVersion: 1,
  metric: 'retrievalRecall@12',
  retrieval: 'bm25',
  fixture: 'x',
  nowIso: '2026-07-14T00:00:00.000Z',
  halfLifeDays: 7,
  k: 12,
  overallFloor: 0.7,
  clusterFloors: { 'single-fact': 1, aggregation: 0.5, recency: 0, 'cross-cutting': 0.6 },
  cases: [],
  reason: 'test',
}

/** Build a candidate recall with explicit cluster values. */
function candidate({ overall, clusters }: { overall: number; clusters: RecallScore['clusters'] }): RecallScore {
  return { overall, clusters, cases: [] }
}

describe('scoreRecall over the frozen fixture', () => {
  it('reproduces the committed baseline exactly (deterministic, no drift)', () => {
    const frozen = loadBaseline({ path: baselinePath() })
    const score = scoreRecall({ records: loadFixtureRecords({ path: fixturePath() }), nowMs: Date.parse(frozen.nowIso), k: frozen.k, halfLifeDays: frozen.halfLifeDays })
    expect(score.overall).toBe(frozen.overallFloor)
    expect(score.clusters).toEqual(frozen.clusterFloors)
  })
})

describe('compareToBaseline', () => {
  it('passes when the candidate equals every floor (equal is not a regression)', () => {
    const diff = compareToBaseline({ candidate: candidate({ overall: 0.7, clusters: { 'single-fact': 1, aggregation: 0.5, recency: 0, 'cross-cutting': 0.6 } }), baseline })
    expect(diff.ok).toBe(true)
    expect(diff.failures).toEqual([])
  })

  it('fails when overall recall drops below the floor', () => {
    const diff = compareToBaseline({ candidate: candidate({ overall: 0.6, clusters: { 'single-fact': 1, aggregation: 0.5, recency: 0, 'cross-cutting': 0.6 } }), baseline })
    expect(diff.ok).toBe(false)
    expect(diff.failures.map((f) => f.scope)).toEqual(['overall'])
    expect(diff.failures[0]!.actual).toBe(0.6)
    expect(diff.failures[0]!.floor).toBe(0.7)
  })

  it('fails on a per-cluster drop even when the overall mean still clears its floor', () => {
    const diff = compareToBaseline({ candidate: candidate({ overall: 0.75, clusters: { 'single-fact': 1, aggregation: 0.4, recency: 0, 'cross-cutting': 0.6 } }), baseline })
    expect(diff.ok).toBe(false)
    expect(diff.failures.map((f) => f.scope)).toEqual(['aggregation'])
  })

  it('keeps a zero-floor cluster passing when the candidate is also zero (no failures at all)', () => {
    const diff = compareToBaseline({ candidate: candidate({ overall: 0.7, clusters: { 'single-fact': 1, aggregation: 0.5, recency: 0, 'cross-cutting': 0.6 } }), baseline })
    expect(diff.ok).toBe(true)
    expect(diff.failures).toEqual([])
  })

  it('does not mutate the baseline (the gate can never move its own floor)', () => {
    compareToBaseline({ candidate: candidate({ overall: 0.1, clusters: { 'single-fact': 0, aggregation: 0, recency: 0, 'cross-cutting': 0 } }), baseline })
    expect(baseline.overallFloor).toBe(0.7)
    expect(baseline.clusterFloors).toEqual({ 'single-fact': 1, aggregation: 0.5, recency: 0, 'cross-cutting': 0.6 })
  })
})
