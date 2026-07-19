import { describe, expect, it } from "vitest";
import { decodeCorpusRecordRow, parseRow } from "./corpusStore.js";

const validRow = {
  container: "o/r",
  kind: "pr",
  refs: ["#1"],
  source: "github",
  sourceId: "gh-1",
  text: "hello",
  tsIso: "2024-01-01T00:00:00Z",
  url: "https://example.test/1",
};

describe("decodeCorpusRecordRow", () => {
  it("decodes a well-formed row", () => {
    expect(decodeCorpusRecordRow({ value: validRow })).toEqual({ record: validRow });
  });

  it("rejects an unknown source", () => {
    expect(decodeCorpusRecordRow({ value: { ...validRow, source: "jira" } })).toEqual({
      error: "unknown source: jira",
    });
  });

  it("rejects an unknown kind", () => {
    expect(decodeCorpusRecordRow({ value: { ...validRow, kind: "wat" } })).toEqual({ error: "unknown kind: wat" });
  });

  it("rejects a missing required field", () => {
    expect(decodeCorpusRecordRow({ value: { ...validRow, text: "" } })).toEqual({
      error: "missing required field (sourceId/tsIso/container/text)",
    });
  });

  it("rejects a non-string url", () => {
    expect(decodeCorpusRecordRow({ value: { ...validRow, url: 5 } })).toEqual({ error: "url must be a string" });
  });

  it("rejects non-string refs", () => {
    expect(decodeCorpusRecordRow({ value: { ...validRow, refs: [1] } })).toEqual({
      error: "refs must be a string array",
    });
  });

  it("keeps well-typed attrs and drops malformed entries", () => {
    expect(decodeCorpusRecordRow({ value: { ...validRow, attrs: { bad: { nested: 1 }, good: "x" } } })).toEqual({
      record: { ...validRow, attrs: { good: "x" } },
    });
  });

  it("keeps an object raw verbatim and preserves author/title", () => {
    expect(decodeCorpusRecordRow({ value: { ...validRow, author: "alice", raw: { a: 1 }, title: "T" } })).toEqual({
      record: { ...validRow, author: "alice", raw: { a: 1 }, title: "T" },
    });
  });
});

describe("parseRow", () => {
  it("returns invalid JSON for a malformed line", () => {
    expect(parseRow({ line: "{not json" })).toEqual({ error: "invalid JSON" });
  });

  it("returns not a JSON object for a JSON array line", () => {
    expect(parseRow({ line: "[1,2]" })).toEqual({ error: "not a JSON object" });
  });

  it("parses a valid JSONL line into a record", () => {
    expect(parseRow({ line: JSON.stringify(validRow) })).toEqual({ record: validRow });
  });
});
