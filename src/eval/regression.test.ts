import { describe, expect, it } from "vitest";

import {
  baselinePath,
  compareToBaseline,
  fixturePath,
  loadBaseline,
  loadFixtureRecords,
  type RecallBaseline,
  type RecallScore,
  scoreRecall,
} from "./regression.js";

/** A synthetic baseline for the pure comparison cases (floors chosen to exercise each branch). */
const baseline: RecallBaseline = {
  cases: [],
  clusterFloors: { aggregation: 0.5, "cross-cutting": 0.6, recency: 0, "single-fact": 1 },
  fixture: "x",
  halfLifeDays: 7,
  k: 12,
  metric: "retrievalRecall@12",
  nowIso: "2026-07-14T00:00:00.000Z",
  overallFloor: 0.7,
  reason: "test",
  retrieval: "bm25",
  schemaVersion: 1,
};

/** Build a candidate recall with explicit cluster values. */
function candidate({ overall, clusters }: { overall: number; clusters: RecallScore["clusters"] }): RecallScore {
  return { cases: [], clusters, overall };
}

describe("scoreRecall over the frozen fixture", () => {
  it("reproduces the committed baseline exactly (deterministic, no drift)", () => {
    const frozen = loadBaseline({ path: baselinePath() });
    const score = scoreRecall({
      halfLifeDays: frozen.halfLifeDays,
      k: frozen.k,
      nowMs: Date.parse(frozen.nowIso),
      records: loadFixtureRecords({ path: fixturePath() }),
    });
    expect(score.overall).toBe(frozen.overallFloor);
    expect(score.clusters).toEqual(frozen.clusterFloors);
  });
});

describe("compareToBaseline", () => {
  it("passes when the candidate equals every floor (equal is not a regression)", () => {
    const diff = compareToBaseline({
      baseline,
      candidate: candidate({
        clusters: { aggregation: 0.5, "cross-cutting": 0.6, recency: 0, "single-fact": 1 },
        overall: 0.7,
      }),
    });
    expect(diff.ok).toBe(true);
    expect(diff.failures).toEqual([]);
  });

  it("fails when overall recall drops below the floor", () => {
    const diff = compareToBaseline({
      baseline,
      candidate: candidate({
        clusters: { aggregation: 0.5, "cross-cutting": 0.6, recency: 0, "single-fact": 1 },
        overall: 0.6,
      }),
    });
    expect(diff.ok).toBe(false);
    expect(diff.failures.map((f) => f.scope)).toEqual(["overall"]);
    expect(diff.failures[0]!.actual).toBe(0.6);
    expect(diff.failures[0]!.floor).toBe(0.7);
  });

  it("fails on a per-cluster drop even when the overall mean still clears its floor", () => {
    const diff = compareToBaseline({
      baseline,
      candidate: candidate({
        clusters: { aggregation: 0.4, "cross-cutting": 0.6, recency: 0, "single-fact": 1 },
        overall: 0.75,
      }),
    });
    expect(diff.ok).toBe(false);
    expect(diff.failures.map((f) => f.scope)).toEqual(["aggregation"]);
  });

  it("keeps a zero-floor cluster passing when the candidate is also zero (no failures at all)", () => {
    const diff = compareToBaseline({
      baseline,
      candidate: candidate({
        clusters: { aggregation: 0.5, "cross-cutting": 0.6, recency: 0, "single-fact": 1 },
        overall: 0.7,
      }),
    });
    expect(diff.ok).toBe(true);
    expect(diff.failures).toEqual([]);
  });

  it("does not mutate the baseline (the gate can never move its own floor)", () => {
    compareToBaseline({
      baseline,
      candidate: candidate({
        clusters: { aggregation: 0, "cross-cutting": 0, recency: 0, "single-fact": 0 },
        overall: 0.1,
      }),
    });
    expect(baseline.overallFloor).toBe(0.7);
    expect(baseline.clusterFloors).toEqual({ aggregation: 0.5, "cross-cutting": 0.6, recency: 0, "single-fact": 1 });
  });
});
