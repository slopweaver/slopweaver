import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { buildRetrievalIndex, search } from "./retrievalIndex.js";

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "t",
  tsIso: "2024-01-01T00:00:00Z",
  url: "u",
  ...over,
});

const index = buildRetrievalIndex({
  records: [
    rec({ sourceId: "#1", text: "the authentication token flow" }),
    rec({ sourceId: "#2", text: "unrelated deployment pipeline" }),
    rec({ sourceId: "#3", text: "more authentication details here" }),
  ],
});

describe("search", () => {
  it("ranks records matching the query terms first", () => {
    const ids = search({ index, limit: 10, query: "authentication" });
    expect(ids).toContain("#1");
    expect(ids).toContain("#3");
    expect(ids).not.toContain("#2");
  });

  it("fails closed to [] on a negative limit", () => {
    expect(search({ index, limit: -1, query: "authentication" })).toEqual([]);
  });
});
