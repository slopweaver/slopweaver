import { describe, expect, it } from "vitest";
import { isScannablePath, scanBoundaryContent, stripNoise } from "./boundaryResidue.js";

describe("scanBoundaryContent (pure)", () => {
  it("flags a raw boundary try/catch (an unwrapped SDK call in a try body)", () => {
    const content = ["try {", "  const r = await client.conversations.history({ channel });", "} catch (e) {}"].join(
      "\n",
    );
    const hits = scanBoundaryContent({ content, path: "src/x.ts" });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.label).toBe("sdk-client-call");
    expect(hits[0]!.line).toBe(2);
  });

  it("flags a direct SDK / embed / rawRequest / complete call outside a wrapper", () => {
    const content = [
      "const a = await client.search({ query });",
      "const b = await embedder.embedDocuments(texts);",
      "const c = await api.rawRequest(q, v);",
      "const d = await llm.complete(params);",
    ].join("\n");
    const labels = scanBoundaryContent({ content, path: "src/x.ts" }).map((h) => h.label);
    expect(labels).toEqual(["sdk-client-call", "embed-call", "graphql-raw-request", "llm-complete"]);
  });

  it("passes a boundary token wrapped in a safe* helper (single- and multi-line)", () => {
    const content = [
      "const res = orThrow({ result: await safeApiCall({",
      "  execute: () => retryTransient({ operation: () => client.conversations.history({ channel }) }),",
      '  operation: "slack.conversations.history",',
      '  provider: "slack",',
      "}) });",
      'const v = await safeEmbed({ execute: () => embedder.embedDocuments(texts), operation: "embed" });',
      'const w = safeFs({ execute: () => writeFileSync(p, s), operation: "w" });',
    ].join("\n");
    expect(scanBoundaryContent({ content, path: "src/ok.ts" })).toEqual([]);
  });

  it("does NOT flag a boundary token NAMED in a comment or string (noise is stripped)", () => {
    const content = [
      "// the raw client.conversations boundary is wrapped elsewhere",
      'const label = "client.search";',
      "/* embedder.embedQuery is described here */",
    ].join("\n");
    expect(scanBoundaryContent({ content, path: "src/ok.ts" })).toEqual([]);
  });

  it("does NOT flag completeStructured (only a `.complete(` call is the LLM boundary)", () => {
    expect(
      scanBoundaryContent({ content: "const r = await completeStructured({ client });", path: "src/ok.ts" }),
    ).toEqual([]);
  });
});

describe("stripNoise", () => {
  it("blanks comment and string interiors but preserves code + newlines", () => {
    const stripped = stripNoise({ content: 'const x = "client.search"; // client.conversations\ncode()' });
    expect(stripped).not.toContain("client.search");
    expect(stripped).not.toContain("client.conversations");
    expect(stripped).toContain("code()");
    expect(stripped.split("\n")).toHaveLength(2); // newline preserved ⇒ line numbers intact
  });
});

describe("isScannablePath", () => {
  it("includes a non-test TypeScript source under src/", () => {
    expect(isScannablePath({ path: "src/corpus/slack/fetch.ts" })).toBe(true);
  });

  it("excludes the scanner's own files, test files, and non-src/non-ts paths", () => {
    expect(isScannablePath({ path: "src/devLint/boundaryResidue.ts" })).toBe(false);
    expect(isScannablePath({ path: "src/corpus/slack/fetch.test.ts" })).toBe(false);
    expect(isScannablePath({ path: "STACK.md" })).toBe(false);
  });
});
