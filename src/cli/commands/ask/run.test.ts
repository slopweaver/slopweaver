import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../../../corpus/types.js";
import { ok, type Result } from "../../../lib/result.js";
import type { Answer } from "../../../retrieval/answerFromSlice.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { type AskDeps, runAskWithDeps } from "./run.js";

const record: CorpusRecord = {
  container: "c",
  kind: "message",
  refs: [],
  source: "slack",
  sourceId: "s1",
  text: "body",
  tsIso: "2026-01-01T00:00:00.000Z",
  url: "https://example.test/s1",
};

const answer = (over: Partial<Answer>): Answer => ({
  answer: "a",
  citations: [],
  citedTokens: [],
  retrieved: 1,
  retrievedRefs: [],
  tldr: "tldr",
  used: 0,
  ...over,
});

/** A capturing, mock-free fake dep set; overrides tune one behaviour per test. */
function fakeDeps(over: Partial<AskDeps> = {}): {
  deps: AskDeps;
  out: string[];
  errs: string[];
  semanticCalls: boolean[];
} {
  const out: string[] = [];
  const errs: string[] = [];
  const semanticCalls: boolean[] = [];
  const deps: AskDeps = {
    answerQuestion: async () => ok(answer({})),
    client: {} as AskDeps["client"],
    home: () => "/h",
    loadCorpus: (): Result<readonly CorpusRecord[]> => ok([record]),
    logger: {
      error: (m) => errs.push(m),
      out: (m) => out.push(m),
      warn: (m) => out.push(m),
    },
    nowMs: () => 0,
    ownerContext: () => ({ owner: undefined }),
    prepareSemantic: ({ semantic }) => {
      semanticCalls.push(semantic);
      return Promise.resolve({ degraded: false });
    },
    ...over,
  };
  return { deps, errs, out, semanticCalls };
}

describe("runAskWithDeps", () => {
  it("prints usage and exits OK on --help", async () => {
    const { deps, out } = fakeDeps();
    expect(await runAskWithDeps({ argv: ["n", "n", "ask", "--help"], deps })).toBe(EXIT_OK);
    expect(out[0]).toContain("usage: slopweaver ask");
  });

  it("returns expected-empty and the no-corpus hint when there is no corpus", async () => {
    const { deps, out } = fakeDeps({ loadCorpus: () => ({ errors: ["missing"], ok: false, warnings: [] }) });
    expect(await runAskWithDeps({ argv: ["n", "n", "ask", "q"], deps })).toBe(EXIT_EXPECTED_EMPTY);
    expect(out).toEqual(["no corpus yet — run `slopweaver refresh` first"]);
  });

  it("passes semantic:true to the prep seam by default", async () => {
    const { deps, semanticCalls } = fakeDeps();
    await runAskWithDeps({ argv: ["n", "n", "ask", "q"], deps });
    expect(semanticCalls).toEqual([true]);
  });

  it("passes semantic:false when --no-semantic is set", async () => {
    const { deps, semanticCalls } = fakeDeps();
    await runAskWithDeps({ argv: ["n", "n", "ask", "q", "--no-semantic"], deps });
    expect(semanticCalls).toEqual([false]);
  });

  it("returns error when the answer engine errors", async () => {
    const { deps } = fakeDeps({ answerQuestion: async () => ({ errors: ["nope"], ok: false, warnings: [] }) });
    expect(await runAskWithDeps({ argv: ["n", "n", "ask", "q"], deps })).toBe(EXIT_ERROR);
  });

  it("writes one JSON object to stdout in --json mode", async () => {
    const { deps, out } = fakeDeps();
    const code = await runAskWithDeps({ argv: ["n", "n", "ask", "q", "--json"], deps });
    expect(code).toBe(EXIT_OK);
    expect(JSON.parse(out[0]!).tldr).toBe("tldr");
  });

  it("returns expected-empty when nothing was retrieved", async () => {
    const { deps } = fakeDeps({ answerQuestion: async () => ok(answer({ retrieved: 0 })) });
    expect(await runAskWithDeps({ argv: ["n", "n", "ask", "q"], deps })).toBe(EXIT_EXPECTED_EMPTY);
  });

  it("returns usage on a blank question", async () => {
    const { deps, errs } = fakeDeps();
    const code = await runAskWithDeps({ argv: ["n", "n", "ask"], deps });
    expect(code).toBe(EXIT_USAGE);
    expect(errs).toContain("ask needs a question");
  });

  it("gives the owner (local CLI) every lane even on an ordinary org ask — private not hidden from yourself", async () => {
    const privateRec: CorpusRecord = { ...record, sourceId: "dm1", visibility: "private" };
    let searched: readonly CorpusRecord[] = [];
    const { deps } = fakeDeps({
      answerQuestion: async ({ records }) => {
        searched = records;
        return ok(answer({}));
      },
      loadCorpus: () => ok([record, privateRec]),
      ownerContext: () => ({ owner: undefined }),
    });
    await runAskWithDeps({ argv: ["n", "n", "ask", "what did the team ship"], deps });
    expect(searched.map((r) => r.sourceId)).toEqual(["s1", "dm1"]);
  });

  it("gives a first-person owner ask the private lane + a handle-injected retrieval query", async () => {
    const privateRec: CorpusRecord = { ...record, sourceId: "dm1", visibility: "private" };
    let searched: readonly CorpusRecord[] = [];
    let retrievalQuery: string | undefined;
    const { deps } = fakeDeps({
      answerQuestion: async ({ records, retrievalQuery: rq }) => {
        searched = records;
        retrievalQuery = rq;
        return ok(answer({}));
      },
      loadCorpus: () => ok([record, privateRec]),
      ownerContext: () => ({ owner: { handles: ["U_OWNER"], personId: "owner-1" } }),
    });
    await runAskWithDeps({ argv: ["n", "n", "ask", "what are my open PRs"], deps });
    expect(searched.map((r) => r.sourceId)).toEqual(["s1", "dm1"]);
    expect(retrievalQuery).toBe("what are my open PRs U_OWNER");
  });
});
