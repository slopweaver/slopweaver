import { describe, expect, it } from "vitest";
import { isScannablePath, scanFunctionLines } from "./maxFunctionLines.js";

describe("scanFunctionLines (pure, TS AST)", () => {
  it("flags a function whose body exceeds the limit", () => {
    const content = ["function big() {", "  const a = 1;", "  const b = 2;", "  return a + b;", "}"].join("\n");
    const hits = scanFunctionLines({ content, max: 3, path: "src/x.ts" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.name).toBe("big");
    expect(hits[0]!.lines).toBe(5);
  });

  it("passes a decomposed pair of small functions", () => {
    const content = ["function core() {", "  return 1;", "}", "function shell() {", "  return core();", "}"].join("\n");
    expect(scanFunctionLines({ content, max: 3, path: "src/x.ts" })).toEqual([]);
  });

  it("names an arrow function by its assigned const", () => {
    const content = ["const runIt = () => {", "  const a = 1;", "  const b = 2;", "  return a + b;", "};"].join("\n");
    expect(scanFunctionLines({ content, max: 3, path: "src/x.ts" })[0]!.name).toBe("runIt");
  });

  it("respects an inline max-lines-exempt marker on the line above", () => {
    const content = [
      "// max-lines-exempt: cohesive shell",
      "function big() {",
      "  const a = 1;",
      "  const b = 2;",
      "  return a + b;",
      "}",
    ].join("\n");
    expect(scanFunctionLines({ content, max: 3, path: "src/x.ts" })).toEqual([]);
  });

  it("does not count a function named inside a comment or string (real AST, not text)", () => {
    const content = [
      "// function fake() { a; b; c; d; e; f; }",
      'const s = "function also() {}";',
      "const x = 1;",
    ].join("\n");
    expect(scanFunctionLines({ content, max: 3, path: "src/x.ts" })).toEqual([]);
  });
});

describe("isScannablePath", () => {
  it("includes a non-test TypeScript source under src/", () => {
    expect(isScannablePath({ path: "src/cli/commands/distil/run.ts" })).toBe(true);
  });

  it("excludes test files and the scanner's own files", () => {
    expect(isScannablePath({ path: "src/cli/commands/distil/run.test.ts" })).toBe(false);
    expect(isScannablePath({ path: "src/devLint/maxFunctionLines.ts" })).toBe(false);
  });
});
