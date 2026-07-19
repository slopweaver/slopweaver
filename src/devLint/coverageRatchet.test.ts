import { describe, expect, it } from "vitest";
import { unwrap, unwrapErr } from "../lib/result.js";
import {
  type CoverageBaseline,
  type CoverageMetrics,
  compareCoverage,
  parseBaselineJson,
  parseCoverageSummary,
  rebaselinePlan,
  round2,
} from "./coverageRatchet.js";

const summaryJson = ({ b, f, l, s }: { b: number; f: number; l: number; s: number }): string =>
  JSON.stringify({
    total: {
      branches: { pct: b },
      functions: { pct: f },
      lines: { pct: l },
      statements: { pct: s },
    },
  });

const metrics = ({ b, f, l, s }: { b: number; f: number; l: number; s: number }): CoverageMetrics => ({
  branches: b,
  functions: f,
  lines: l,
  statements: s,
});

const baseline = ({ b, f, l, s }: { b: number; f: number; l: number; s: number }): CoverageBaseline => ({
  summary: metrics({ b, f, l, s }),
  version: 1,
});

describe("round2", () => {
  it("rounds to two decimals", () => {
    expect(round2({ value: 85.126 })).toBe(85.13);
  });
});

describe("parseCoverageSummary", () => {
  it("extracts the four rounded total percentages", () => {
    const result = parseCoverageSummary({ text: summaryJson({ b: 80.005, f: 90, l: 88.1, s: 87 }) });
    expect(result.ok).toBe(true);
    expect(unwrap(result)).toEqual({ branches: 80.01, functions: 90, lines: 88.1, statements: 87 });
  });

  it("errors on malformed JSON", () => {
    const result = parseCoverageSummary({ text: "{bad" });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result)).toEqual(["coverage summary: invalid JSON"]);
  });

  it("errors on an unexpected shape", () => {
    const result = parseCoverageSummary({ text: JSON.stringify({ total: { lines: { pct: 1 } } }) });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result)).toEqual([
      "coverage summary: unexpected shape (expected total.{branches,functions,lines,statements}.pct)",
    ]);
  });
});

describe("parseBaselineJson", () => {
  it("decodes a well-formed baseline", () => {
    const result = parseBaselineJson({
      text: JSON.stringify({ summary: { branches: 80, functions: 85, lines: 85, statements: 85 }, version: 1 }),
    });
    expect(result.ok).toBe(true);
    expect(unwrap(result).summary.branches).toBe(80);
  });

  it("errors on an unexpected shape", () => {
    const result = parseBaselineJson({ text: JSON.stringify({ version: 1 }) });
    expect(result.ok).toBe(false);
    expect(unwrapErr(result)).toEqual([
      "coverage baseline: unexpected shape (expected version + summary.{branches,functions,lines,statements})",
    ]);
  });
});

describe("compareCoverage", () => {
  it("passes when every metric equals the floor", () => {
    const verdict = compareCoverage({
      baseline: metrics({ b: 80, f: 85, l: 85, s: 85 }),
      current: metrics({ b: 80, f: 85, l: 85, s: 85 }),
    });
    expect(verdict.ok).toBe(true);
    expect(verdict.failures).toEqual([]);
  });

  it("passes when coverage is higher", () => {
    const verdict = compareCoverage({
      baseline: metrics({ b: 80, f: 85, l: 85, s: 85 }),
      current: metrics({ b: 90, f: 95, l: 95, s: 95 }),
    });
    expect(verdict.ok).toBe(true);
  });

  it("fails when line coverage drops", () => {
    const verdict = compareCoverage({
      baseline: metrics({ b: 80, f: 85, l: 85, s: 85 }),
      current: metrics({ b: 80, f: 85, l: 84.99, s: 85 }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(["lines: 84.99% < floor 85%"]);
  });

  it("fails when branch coverage drops", () => {
    const verdict = compareCoverage({
      baseline: metrics({ b: 80, f: 85, l: 85, s: 85 }),
      current: metrics({ b: 79, f: 85, l: 85, s: 85 }),
    });
    expect(verdict.ok).toBe(false);
    expect(verdict.failures).toEqual(["branches: 79% < floor 80%"]);
  });
});

describe("rebaselinePlan", () => {
  it("writes a higher baseline when every metric is at/above the floor", () => {
    const plan = rebaselinePlan({
      baseline: baseline({ b: 80, f: 85, l: 85, s: 85 }),
      current: metrics({ b: 82, f: 86, l: 87, s: 88 }),
    });
    expect(plan.ok).toBe(true);
    expect(unwrap(plan).summary).toEqual({ branches: 82, functions: 86, lines: 87, statements: 88 });
  });

  it("refuses to lower any metric, naming the offender", () => {
    const plan = rebaselinePlan({
      baseline: baseline({ b: 80, f: 85, l: 85, s: 85 }),
      current: metrics({ b: 80, f: 85, l: 84, s: 85 }),
    });
    expect(plan.ok).toBe(false);
    expect(unwrapErr(plan)).toEqual(["rebaseline refused — would lower: lines"]);
  });
});
