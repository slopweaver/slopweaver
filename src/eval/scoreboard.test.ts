import { describe, expect, it } from "vitest";
import { aggregateCase, type CaseAggregate, median, renderScoreboard } from "./scoreboard.js";
import type { GroundingScore } from "./scorer.js";

/** Build a GroundingScore with only the fields a test cares about; the rest are consistent filler. */
function score({
  retrievalRecall,
  answerRecall,
  citationPrecision,
  expectedCount,
}: {
  retrievalRecall: number;
  answerRecall: number;
  citationPrecision: number;
  expectedCount: number;
}): GroundingScore {
  return {
    answerRecall,
    citationPrecision,
    citedCount: 1,
    citedHits: Math.round(answerRecall * expectedCount),
    expectedCount,
    retrievalRecall,
    retrievedHits: Math.round(retrievalRecall * expectedCount),
  };
}

describe("median", () => {
  it("returns the middle value for an odd count", () => {
    expect(median({ values: [0.6, 0.2, 0.4] })).toBe(0.4);
  });

  it("averages the two middle values for an even count", () => {
    expect(median({ values: [0.2, 0.4, 0.6, 0.8] })).toBe(0.5);
  });

  it("returns the sole value for a single rep", () => {
    expect(median({ values: [0.2] })).toBe(0.2);
  });
});

describe("aggregateCase", () => {
  it("takes deterministic retrieval recall from the reps and summarises answer-level as median + range", () => {
    const scores: GroundingScore[] = [
      score({ answerRecall: 0.2, citationPrecision: 0.5, expectedCount: 5, retrievalRecall: 0.2 }),
      score({ answerRecall: 0.6, citationPrecision: 0.5, expectedCount: 5, retrievalRecall: 0.2 }),
      score({ answerRecall: 0.4, citationPrecision: 0.5, expectedCount: 5, retrievalRecall: 0.2 }),
    ];
    const agg = aggregateCase({ kind: "aggregation", question: "q", scores });
    expect(agg.reps).toBe(3);
    expect(agg.expectedCount).toBe(5);
    expect(agg.retrievalRecall).toBe(0.2);
    expect(agg.retrievalStable).toBe(true);
    expect(agg.answerRecall).toEqual({ max: 0.6, median: 0.4, min: 0.2 });
    expect(agg.citationPrecision).toEqual({ max: 0.5, median: 0.5, min: 0.5 });
  });

  it("flags retrieval as unstable when the reps disagree", () => {
    const scores: GroundingScore[] = [
      score({ answerRecall: 0.2, citationPrecision: 0.5, expectedCount: 5, retrievalRecall: 0.2 }),
      score({ answerRecall: 0.2, citationPrecision: 0.5, expectedCount: 5, retrievalRecall: 0.4 }),
    ];
    const agg = aggregateCase({ kind: "recency", question: "q", scores });
    expect(agg.retrievalStable).toBe(false);
    expect(agg.retrievalRecall).toBe(0.2);
  });
});

describe("renderScoreboard", () => {
  const rows: CaseAggregate[] = [
    {
      answerRecall: { max: 0, median: 0, min: 0 },
      citationPrecision: { max: 1, median: 1, min: 1 },
      expectedCount: 1,
      kind: "single-fact",
      question: "q1",
      reps: 3,
      retrievalRecall: 0,
      retrievalStable: true,
    },
    {
      answerRecall: { max: 0.8, median: 0.6, min: 0.4 },
      citationPrecision: { max: 0.5, median: 0.5, min: 0.5 },
      expectedCount: 5,
      kind: "aggregation",
      question: "q2",
      reps: 3,
      retrievalRecall: 0.8,
      retrievalStable: true,
    },
  ];

  it("renders a summary line with mean retrieval recall and the red count", () => {
    const lines = renderScoreboard({ rows }).split("\n");
    expect(lines[0]).toBe(
      "**Mean retrieval recall@k: 40%** across 2 cases · 1 red (retrieval recall < 50%) · answer-level metrics over 3 reps (median [min–max]).",
    );
  });

  it("marks a low-recall case red and a high-recall case green, collapsing a zero-spread range", () => {
    const lines = renderScoreboard({ rows }).split("\n");
    expect(lines[4]).toBe("| 🔴 | single-fact | q1 | 0% (0/1) | 0% | 100% |");
    expect(lines[5]).toBe("| 🟢 | aggregation | q2 | 80% (4/5) | 60% [40%–80%] | 50% |");
  });
});
