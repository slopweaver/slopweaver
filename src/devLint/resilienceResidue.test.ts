import { describe, expect, it } from "vitest";
import { isScannablePath, scanResilienceContent } from "./resilienceResidue.js";

describe("scanResilienceContent (pure)", () => {
  it("flags a reintroduced hand-rolled rate limiter by its class name", () => {
    const hits = scanResilienceContent({
      content: "const gate = new RateBucket({ ratePerSec: 3 });",
      path: "src/x.ts",
    });
    expect(hits).toEqual([{ excerpt: "RateBucket", label: "hand-rolled-rate-limiter", line: 1, path: "src/x.ts" }]);
  });

  it("flags an import of a deleted resilience module", () => {
    const hits = scanResilienceContent({ content: 'import { retry } from "../../lib/retry.js";', path: "src/y.ts" });
    expect(hits).toEqual([{ excerpt: "lib/retry.js", label: "deleted-resilience-module", line: 1, path: "src/y.ts" }]);
  });

  it("flags a bespoke retry function declaration", () => {
    const hits = scanResilienceContent({
      content: "export async function retry(op) { return op(); }",
      path: "src/z.ts",
    });
    expect(hits).toEqual([{ excerpt: "async function retry", label: "bespoke-retry-decl", line: 1, path: "src/z.ts" }]);
  });

  it("flags token-bucket wording (the signature of a hand-rolled pacer)", () => {
    const hits = scanResilienceContent({ content: "// a continuously-refilling token bucket", path: "src/z.ts" });
    expect(hits).toEqual([{ excerpt: "token bucket", label: "token-bucket", line: 1, path: "src/z.ts" }]);
  });

  it("allows the library seams and octokit's named retry import (no false positives)", () => {
    const content = [
      'import pRetry from "p-retry";',
      'import { retry, throttling } from "@octokit/plugin-retry";',
      'import { retryTransient, createRateScheduler } from "../../lib/resilience.js";',
      "const gate = createRateScheduler({ ratePerSec: 3 });",
      "await retryTransient({ operation: () => call() });",
    ].join("\n");
    expect(scanResilienceContent({ content, path: "src/ok.ts" })).toEqual([]);
  });

  it("reports the correct line number for a hit below the first line", () => {
    const hits = scanResilienceContent({ content: "line one\nline two\nnew RateBucket({})", path: "src/x.ts" });
    expect(hits).toEqual([{ excerpt: "RateBucket", label: "hand-rolled-rate-limiter", line: 3, path: "src/x.ts" }]);
  });
});

describe("isScannablePath", () => {
  it("includes a TypeScript source under src/", () => {
    expect(isScannablePath({ path: "src/corpus/slack/fetch.ts" })).toBe(true);
  });

  it("excludes the scanner's own files (they name the forbidden patterns)", () => {
    expect(isScannablePath({ path: "src/devLint/resilienceResidue.ts" })).toBe(false);
    expect(isScannablePath({ path: "src/devLint/resilienceResidue.test.ts" })).toBe(false);
  });

  it("excludes non-src paths and non-TypeScript files", () => {
    expect(isScannablePath({ path: "STACK.md" })).toBe(false);
    expect(isScannablePath({ path: "scripts/check-hygiene.sh" })).toBe(false);
    expect(isScannablePath({ path: "src/corpus/types.json" })).toBe(false);
  });
});
