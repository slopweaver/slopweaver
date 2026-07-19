import { describe, expect, it } from "vitest";
import { compareNumbersDesc, compareScoreDescThenIdAsc, compareStrings } from "./compare.js";

describe("compareStrings", () => {
  it("sorts ascending by code point", () => {
    expect(["b", "a", "a"].toSorted((a, b) => compareStrings({ a, b }))).toEqual(["a", "a", "b"]);
  });

  it("returns 0 for equal strings", () => {
    expect(compareStrings({ a: "x", b: "x" })).toBe(0);
  });

  it("returns -1 when a precedes b", () => {
    expect(compareStrings({ a: "a", b: "b" })).toBe(-1);
  });

  it("returns 1 when a follows b", () => {
    expect(compareStrings({ a: "b", b: "a" })).toBe(1);
  });
});

describe("compareNumbersDesc", () => {
  it("orders larger first", () => {
    expect([1, 3, 2].toSorted((a, b) => compareNumbersDesc({ a, b }))).toEqual([3, 2, 1]);
  });

  it("returns 0 for equal numbers", () => {
    expect(compareNumbersDesc({ a: 5, b: 5 })).toBe(0);
  });
});

describe("compareScoreDescThenIdAsc", () => {
  it("orders by score descending", () => {
    const pairs: [string, number][] = [
      ["a", 1],
      ["b", 3],
      ["c", 2],
    ];
    expect(pairs.toSorted((a, b) => compareScoreDescThenIdAsc({ a, b })).map(([id]) => id)).toEqual(["b", "c", "a"]);
  });

  it("breaks score ties by id ascending", () => {
    const pairs: [string, number][] = [
      ["c", 5],
      ["a", 5],
      ["b", 5],
    ];
    expect(pairs.toSorted((a, b) => compareScoreDescThenIdAsc({ a, b })).map(([id]) => id)).toEqual(["a", "b", "c"]);
  });

  it("returns 0 for identical tuples", () => {
    expect(compareScoreDescThenIdAsc({ a: ["x", 1], b: ["x", 1] })).toBe(0);
  });
});
