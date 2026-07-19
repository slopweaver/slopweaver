import { describe, expect, it } from "vitest";
import { countBy, incrementCount, sortedUnique, takeClamped } from "./collections.js";

describe("sortedUnique", () => {
  it("dedups and sorts ascending", () => {
    expect(sortedUnique({ values: ["b", "a", "b", "c", "a"] })).toEqual(["a", "b", "c"]);
  });

  it("returns [] for empty input", () => {
    expect(sortedUnique({ values: [] })).toEqual([]);
  });

  it("leaves a single value unchanged", () => {
    expect(sortedUnique({ values: ["only"] })).toEqual(["only"]);
  });
});

describe("countBy", () => {
  it("counts repeated keys exactly", () => {
    expect([...countBy({ keys: ["a", "b", "a", "a", "b"] }).entries()]).toEqual([
      ["a", 3],
      ["b", 2],
    ]);
  });

  it("returns an empty map for no keys", () => {
    expect(countBy({ keys: [] }).size).toBe(0);
  });
});

describe("incrementCount", () => {
  it("starts an absent key at 1", () => {
    const counts = new Map<string, number>();
    expect(incrementCount({ counts, key: "x" }).get("x")).toBe(1);
  });

  it("bumps an existing key", () => {
    const counts = new Map<string, number>([["x", 4]]);
    expect(incrementCount({ counts, key: "x" }).get("x")).toBe(5);
  });
});

describe("takeClamped", () => {
  it("takes the first N with a positive limit", () => {
    expect(takeClamped({ items: [1, 2, 3, 4], limit: 2 })).toEqual([1, 2]);
  });

  it("returns [] for a zero limit", () => {
    expect(takeClamped({ items: [1, 2, 3], limit: 0 })).toEqual([]);
  });

  it("returns [] for a negative limit (does not drop the tail)", () => {
    expect(takeClamped({ items: [1, 2, 3], limit: -1 })).toEqual([]);
  });

  it("returns all items when the limit exceeds length", () => {
    expect(takeClamped({ items: [1, 2], limit: 9 })).toEqual([1, 2]);
  });
});
