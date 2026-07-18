import { describe, expect, it } from "vitest";
import { bm25Idf, bm25TermScore } from "./bm25.js";

describe("bm25Idf", () => {
  it("is higher for rarer terms and never negative", () => {
    const rare = bm25Idf({ df: 1, docCount: 100 });
    const common = bm25Idf({ df: 90, docCount: 100 });
    expect(rare).toBeGreaterThan(common);
    expect(common).toBeGreaterThanOrEqual(0);
  });
});

describe("bm25TermScore", () => {
  const stats = { avgDocLength: 50, docCount: 100 };

  it("scores 0 for an absent term", () => {
    expect(bm25TermScore({ docFrequency: 5, docLength: 50, stats, termFrequency: 0 })).toBe(0);
  });

  it("increases with term frequency (saturating)", () => {
    const one = bm25TermScore({ docFrequency: 5, docLength: 50, stats, termFrequency: 1 });
    const three = bm25TermScore({ docFrequency: 5, docLength: 50, stats, termFrequency: 3 });
    expect(three).toBeGreaterThan(one);
  });
});
