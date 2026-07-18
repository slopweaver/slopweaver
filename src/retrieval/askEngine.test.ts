import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { unwrap } from "../lib/result.js";
import type { LlmClient } from "../llm/provider.js";
import { answerQuestion, retrieveRecords } from "./askEngine.js";

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
const records = [
  rec({ sourceId: "#1", text: "authentication token flow" }),
  rec({ sourceId: "#2", text: "deployment pipeline" }),
];

describe("retrieveRecords", () => {
  it("returns the BM25-ranked slice mapped back to records", () => {
    const slice = retrieveRecords({ question: "authentication", records, sliceLimit: 5 });
    expect(slice.map((r) => r.sourceId)).toEqual(["#1"]);
  });
});

describe("answerQuestion", () => {
  it("retrieves then composes an answer", async () => {
    const client: LlmClient = {
      complete: async () => ({ content: [{ input: { citations: ["#1"], tldr: "auth flow (#1)" }, type: "tool_use" }] }),
    };
    const answer = unwrap(await answerQuestion({ client, question: "authentication", records, sliceLimit: 5 }));
    expect(answer.used).toBe(1);
  });
});
