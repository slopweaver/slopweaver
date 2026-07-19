import { describe, expect, it } from "vitest";
import { isScannablePath, MAX_FUNCTION_LINES, scanFunctionLines } from "./maxFunctionLines.js";

/** A function whose body spans exactly `lines` source lines (`function f() {` … `}`). */
function functionOfLines({ lines }: { lines: number }): string {
  const body = Array.from({ length: lines - 2 }, (_, i) => `  const v${String(i)} = ${String(i)};`);
  return ["function f() {", ...body, "}"].join("\n");
}

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

describe("MAX_FUNCTION_LINES ceiling (locked at 60)", () => {
  it("is 60", () => {
    expect(MAX_FUNCTION_LINES).toBe(60);
  });

  it("passes a function of exactly 60 lines", () => {
    expect(scanFunctionLines({ content: functionOfLines({ lines: 60 }), path: "src/x.ts" })).toEqual([]);
  });

  it("flags a function of 61 lines", () => {
    const hits = scanFunctionLines({ content: functionOfLines({ lines: 61 }), path: "src/x.ts" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.lines).toBe(61);
  });

  it("exempts a 61-line function marked directly above", () => {
    const content = `// max-lines-exempt: cohesive shell\n${functionOfLines({ lines: 61 })}`;
    expect(scanFunctionLines({ content, path: "src/x.ts" })).toEqual([]);
  });

  it("does not exempt when the marker is two lines above the function", () => {
    const content = `// max-lines-exempt: too far\n\n${functionOfLines({ lines: 61 })}`;
    expect(scanFunctionLines({ content, path: "src/x.ts" })).toHaveLength(1);
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
