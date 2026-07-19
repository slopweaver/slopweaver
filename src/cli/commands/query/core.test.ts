import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../../../corpus/types.js";
import type { Answer } from "../../../retrieval/answerFromSlice.js";
import { EXIT_EXPECTED_EMPTY, EXIT_OK } from "../../exitCodes.js";
import {
  askExitCode,
  factsExitCode,
  normaliseFactSnippet,
  renderAskTextLines,
  renderFactsLines,
  validateAskQuestion,
  validateFactsQuestion,
} from "./core.js";

const answer = (over: Partial<Answer>): Answer => ({
  answer: "a",
  citations: [],
  citedTokens: [],
  retrieved: 0,
  retrievedRefs: [],
  tldr: "the tldr",
  used: 0,
  ...over,
});

const record = (over: Partial<CorpusRecord>): CorpusRecord => ({
  container: "c",
  kind: "message",
  refs: [],
  source: "slack",
  sourceId: "s1",
  text: "body",
  tsIso: "2026-01-01T00:00:00.000Z",
  url: "https://example.test/s1",
  ...over,
});

describe("validateAskQuestion", () => {
  it("accepts a real question", () => {
    expect(validateAskQuestion({ question: "what changed?" })).toBeUndefined();
  });

  it("rejects a blank question with the exact usage line", () => {
    expect(validateAskQuestion({ question: "   " })).toBe("ask needs a question");
  });
});

describe("validateFactsQuestion", () => {
  it("accepts a real question", () => {
    expect(validateFactsQuestion({ question: "auth" })).toBeUndefined();
  });

  it("rejects an empty question with the exact usage line", () => {
    expect(validateFactsQuestion({ question: "" })).toBe("facts needs a question");
  });
});

describe("renderAskTextLines", () => {
  it("renders tldr only when there are no details or citations", () => {
    expect(renderAskTextLines({ answer: answer({}) })).toEqual(["the tldr"]);
  });

  it("renders tldr, blank, details when details are present", () => {
    expect(renderAskTextLines({ answer: answer({ details: "more" }) })).toEqual(["the tldr", "", "more"]);
  });

  it("omits an empty details string", () => {
    expect(renderAskTextLines({ answer: answer({ details: "" }) })).toEqual(["the tldr"]);
  });

  it("renders a citations block after the answer in order", () => {
    expect(renderAskTextLines({ answer: answer({ citations: ["u1", "u2"] }) })).toEqual([
      "the tldr",
      "",
      "citations:",
      "  u1",
      "  u2",
    ]);
  });

  it("renders details then citations", () => {
    expect(renderAskTextLines({ answer: answer({ citations: ["u1"], details: "d" }) })).toEqual([
      "the tldr",
      "",
      "d",
      "",
      "citations:",
      "  u1",
    ]);
  });
});

describe("askExitCode", () => {
  it("is OK when something was retrieved", () => {
    expect(askExitCode({ retrieved: 3 })).toBe(EXIT_OK);
  });

  it("is expected-empty when nothing was retrieved", () => {
    expect(askExitCode({ retrieved: 0 })).toBe(EXIT_EXPECTED_EMPTY);
  });
});

describe("normaliseFactSnippet", () => {
  it("collapses all whitespace runs to single spaces", () => {
    expect(normaliseFactSnippet({ maxChars: 200, text: "a\n\tb   c" })).toBe("a b c");
  });

  it("caps the length at maxChars", () => {
    expect(normaliseFactSnippet({ maxChars: 3, text: "abcdef" })).toBe("abc");
  });
});

describe("renderFactsLines", () => {
  it("prints the no-match line for an empty slice", () => {
    expect(renderFactsLines({ slice: [] })).toEqual(["no matching records"]);
  });

  it("renders [source] (token) url, snippet, and a trailing blank per record", () => {
    const lines = renderFactsLines({ slice: [record({ text: "hello  world" })] });
    expect(lines).toEqual(["[slack] (s1) https://example.test/s1", "  hello world", ""]);
  });

  it("includes the title line when a title is present", () => {
    const lines = renderFactsLines({ slice: [record({ text: "x", title: "The Title" })] });
    expect(lines).toEqual(["[slack] (s1) https://example.test/s1", "  The Title", "  x", ""]);
  });

  it("omits an empty title", () => {
    const lines = renderFactsLines({ slice: [record({ text: "x", title: "" })] });
    expect(lines).toEqual(["[slack] (s1) https://example.test/s1", "  x", ""]);
  });
});

describe("factsExitCode", () => {
  it("is always OK", () => {
    expect(factsExitCode()).toBe(EXIT_OK);
  });
});
