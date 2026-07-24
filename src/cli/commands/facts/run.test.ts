import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../../../corpus/types.js";
import { ok, type Result } from "../../../lib/result.js";
import { EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { type FactsDeps, runFactsWithDeps } from "./run.js";

const record: CorpusRecord = {
  container: "c",
  kind: "message",
  refs: [],
  source: "slack",
  sourceId: "s1",
  text: "hello world",
  tsIso: "2026-01-01T00:00:00.000Z",
  url: "https://example.test/s1",
};

function fakeDeps(over: Partial<FactsDeps> = {}): { deps: FactsDeps; out: string[]; errs: string[] } {
  const out: string[] = [];
  const errs: string[] = [];
  const deps: FactsDeps = {
    home: () => "/h",
    loadCorpus: (): Result<readonly CorpusRecord[]> => ok([record]),
    logger: {
      error: (m) => errs.push(m),
      out: (m) => out.push(m),
      warn: (m) => out.push(m),
    },
    nowMs: () => 0,
    ownerContext: () => ({ owner: undefined }),
    prepareSemantic: () => Promise.resolve({ degraded: false }),
    retrieveRecords: () => [record],
    ...over,
  };
  return { deps, errs, out };
}

describe("runFactsWithDeps", () => {
  it("prints usage and exits OK on --help", async () => {
    const { deps, out } = fakeDeps();
    expect(await runFactsWithDeps({ argv: ["n", "n", "facts", "-h"], deps })).toBe(EXIT_OK);
    expect(out[0]).toContain("usage: slopweaver facts");
  });

  it("returns usage on a blank question", async () => {
    const { deps, errs } = fakeDeps();
    expect(await runFactsWithDeps({ argv: ["n", "n", "facts"], deps })).toBe(EXIT_USAGE);
    expect(errs).toContain("facts needs a question");
  });

  it("returns expected-empty when there is no corpus", async () => {
    const { deps, out } = fakeDeps({ loadCorpus: () => ({ errors: ["x"], ok: false, warnings: [] }) });
    expect(await runFactsWithDeps({ argv: ["n", "n", "facts", "q"], deps })).toBe(EXIT_EXPECTED_EMPTY);
    expect(out).toEqual(["no corpus yet — run `slopweaver refresh` first"]);
  });

  it("prints the no-match line and exits OK for an empty slice", async () => {
    const { deps, out } = fakeDeps({ retrieveRecords: () => [] });
    expect(await runFactsWithDeps({ argv: ["n", "n", "facts", "q"], deps })).toBe(EXIT_OK);
    expect(out).toEqual(["no matching records"]);
  });

  it("prints the record block for a non-empty slice and exits OK", async () => {
    const { deps, out } = fakeDeps();
    expect(await runFactsWithDeps({ argv: ["n", "n", "facts", "q"], deps })).toBe(EXIT_OK);
    expect(out).toEqual(["[slack] (s1) https://example.test/s1", "  hello world", ""]);
  });

  it("searches every lane for the owner (local CLI) on an org ask — private not hidden from yourself", async () => {
    const privateRec: CorpusRecord = { ...record, sourceId: "dm1", visibility: "private" };
    let searched: readonly CorpusRecord[] = [];
    const { deps } = fakeDeps({
      loadCorpus: () => ok([record, privateRec]),
      ownerContext: () => ({ owner: undefined }),
      retrieveRecords: ({ records }) => {
        searched = records;
        return [];
      },
    });
    await runFactsWithDeps({ argv: ["n", "n", "facts", "what did the team ship"], deps });
    expect(searched.map((r) => r.sourceId)).toEqual(["s1", "dm1"]);
  });

  it("searches the private lane for a first-person owner ask", async () => {
    const privateRec: CorpusRecord = { ...record, sourceId: "dm1", visibility: "private" };
    let searched: readonly CorpusRecord[] = [];
    const { deps } = fakeDeps({
      loadCorpus: () => ok([record, privateRec]),
      ownerContext: () => ({ owner: { handles: ["U_OWNER"], personId: "owner-1" } }),
      retrieveRecords: ({ records }) => {
        searched = records;
        return [];
      },
    });
    await runFactsWithDeps({ argv: ["n", "n", "facts", "what is assigned to me"], deps });
    expect(searched.map((r) => r.sourceId)).toEqual(["s1", "dm1"]);
  });
});
