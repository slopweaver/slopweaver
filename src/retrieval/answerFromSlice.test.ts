import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { unwrap } from "../lib/result.js";
import type { LlmClient } from "../llm/provider.js";
import {
  answerFromSlice,
  retrievedRefsFromSlice,
  stripUnresolvedCitations,
  validateAnswer,
} from "./answerFromSlice.js";

const rec: CorpusRecord = {
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "x",
  tsIso: "t",
  url: "u1",
};
const evidenceTokens = new Set(["#1"]);
const urlByToken = new Map([["#1", "u1"]]);

const toolClient = (input: unknown): LlmClient => ({
  complete: async () => ({ content: [{ input, type: "tool_use" }] }),
});

describe("stripUnresolvedCitations", () => {
  it("drops unresolved token parentheticals (incl. compound ids), keeps prose parentheticals", () => {
    expect(
      stripUnresolvedCitations({ surviving: new Set(["#1"]), text: "a (#1) b (#99:comment:1) c (see note)" }),
    ).toBe("a (#1) b c (see note)");
  });
});

describe("validateAnswer", () => {
  it("keeps backed citations, drops invented ones, passes retrieved through", () => {
    const answer = unwrap(
      validateAnswer({
        evidenceTokens,
        input: { citations: ["#1", "#99"], tldr: "found it (#1) and (#99)" },
        retrievedRefs: [{ sourceId: "#1", token: "#1", url: "u1" }],
        urlByToken,
      }),
    );
    expect(answer.citations).toEqual(["u1"]);
    expect(answer.used).toBe(1);
    expect(answer.retrieved).toBe(1);
    expect(answer.tldr).toBe("found it (#1) and");
    expect(answer.citedTokens).toEqual(["#1"]);
  });

  it("captures a citation the model only wrote inline (empty citations[])", () => {
    const answer = unwrap(
      validateAnswer({
        evidenceTokens,
        input: { citations: [], tldr: "grounded here (#1)" },
        retrievedRefs: [{ sourceId: "#1", token: "#1", url: "u1" }],
        urlByToken,
      }),
    );
    expect(answer.citations).toEqual(["u1"]);
    expect(answer.used).toBe(1);
  });

  it("errs on a malformed answer", () => {
    expect(
      validateAnswer({
        evidenceTokens,
        input: { tldr: 5 },
        retrievedRefs: [{ sourceId: "#1", token: "#1", url: "u1" }],
        urlByToken,
      }).ok,
    ).toBe(false);
  });
});

describe("answerFromSlice", () => {
  it('returns a "nothing matched" answer with retrieved 0 for an empty slice, without calling the model', async () => {
    const client: LlmClient = {
      complete: async () => {
        throw new Error("should not be called");
      },
    };
    const answer = unwrap(await answerFromSlice({ client, question: "q", slice: [] }));
    expect(answer).toMatchObject({ retrieved: 0, used: 0 });
  });

  it("composes a grounded answer from the slice", async () => {
    const answer = unwrap(
      await answerFromSlice({
        client: toolClient({ citations: ["#1"], tldr: "the answer (#1)" }),
        question: "q",
        slice: [rec],
      }),
    );
    expect(answer.citations).toEqual(["u1"]);
    expect(answer.retrieved).toBe(1);
  });

  it("lets a gold record ground a citation to an id it MENTIONS (the gold-digest case)", async () => {
    const gold: CorpusRecord = {
      container: "gold",
      kind: "finding",
      refs: [],
      source: "gold",
      sourceId: "gold:x#y",
      text: "PR #88 added the cache (#88:comment:2).",
      title: "Summary",
      tsIso: "t",
      url: "gold://x#y",
    };
    // The model cites #88:comment:2 — not gold's own token, but an id the gold record references.
    const answer = unwrap(
      await answerFromSlice({
        client: toolClient({ citations: ["#88:comment:2"], tldr: "cache added (#88:comment:2)" }),
        question: "q",
        slice: [gold],
      }),
    );
    expect(answer.used).toBe(1);
    expect(answer.citations).toEqual(["gold://x#y"]);
  });
});

describe("retrievedRefsFromSlice", () => {
  it("maps each sliced record to its sourceId, cite token, and url", () => {
    const gold: CorpusRecord = {
      container: "gold",
      kind: "finding",
      refs: [],
      source: "gold",
      sourceId: "gold:x",
      text: "y",
      tsIso: "t",
      url: "gold://x",
    };
    expect(retrievedRefsFromSlice({ slice: [rec, gold] })).toEqual([
      { sourceId: "#1", token: "#1", url: "u1" },
      { sourceId: "gold:x", token: "gold:x", url: "gold://x" },
    ]);
  });
});
