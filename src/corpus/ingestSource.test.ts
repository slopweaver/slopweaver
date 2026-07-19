import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { err, ok, type Result, unwrap } from "../lib/result.js";
import { bronzeSourceDir } from "./corpusPaths.js";
import { readCorpusDir } from "./corpusStore.js";
import type { WriteResult } from "./corpusWriter.js";
import {
  emptyFetchResult,
  fetchFailureResult,
  type IngestDeps,
  type IngestProgress,
  ingestSources,
  type SourceIngestJob,
  successfulIngestResult,
  writeFailureResult,
} from "./ingestSource.js";
import type { CorpusRecord } from "./types.js";
import { readWatermark } from "./watermark.js";

const window = { since: "2026-01-01", until: "2026-06-01" };
type RunResult = Result<{ records: readonly CorpusRecord[]; warnings: readonly string[] }>;

const slackRecord: CorpusRecord = {
  container: "slack/C_A",
  kind: "message",
  refs: [],
  source: "slack",
  sourceId: "C_A:1.1",
  text: "hello",
  tsIso: "2026-05-01T00:00:00.000Z",
  url: "u",
};

function tempHome(): string {
  return join(mkdtempSync(join(tmpdir(), "slopweaver-ingest-")), "home");
}

describe("ingestSources", () => {
  it("writes a source's records to its bronze dir and advances only its watermark", async () => {
    const home = tempHome();
    const job: SourceIngestJob = {
      label: "slack",
      run: async (): Promise<RunResult> => ok({ records: [slackRecord], warnings: ["skipped 1 thread"] }),
      source: "slack",
      window,
    };
    const result = unwrap(await ingestSources({ home, jobs: [job] }))[0]!;
    expect(result.ok).toBe(true);
    expect(result.written).toBe(1);
    expect(result.warnings).toEqual(["skipped 1 thread"]);
    expect(readWatermark({ home, source: "slack" })).toBe("2026-05-01T00:00:00.000Z");
    expect(readWatermark({ home, source: "github" })).toBeUndefined();
    expect(unwrap(readCorpusDir({ dir: bronzeSourceDir({ home, source: "slack" }) })).map((r) => r.sourceId)).toEqual([
      "C_A:1.1",
    ]);
  });

  it("advances the watermark to `until` on a successful empty window (no fake records written)", async () => {
    const home = tempHome();
    const job: SourceIngestJob = {
      label: "linear",
      run: async (): Promise<RunResult> => ok({ records: [], warnings: [] }),
      source: "linear",
      window,
    };
    const result = unwrap(await ingestSources({ home, jobs: [job] }))[0]!;
    expect(result.written).toBe(0);
    expect(readWatermark({ home, source: "linear" })).toBe("2026-06-01");
  });

  it("reports a failing source without aborting the run", async () => {
    const home = tempHome();
    const job: SourceIngestJob = {
      label: "notion",
      run: async (): Promise<RunResult> => err(["notion: 401"]),
      source: "notion",
      window,
    };
    const result = unwrap(await ingestSources({ home, jobs: [job] }))[0]!;
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["notion: 401"]);
  });
});

describe("pure result builders", () => {
  it("fetchFailureResult surfaces errors with zero counts", () => {
    expect(fetchFailureResult({ errors: ["boom"], source: "github" })).toEqual({
      deduped: 0,
      errors: ["boom"],
      ok: false,
      projected: 0,
      source: "github",
      warnings: [],
      written: 0,
    });
  });

  it("emptyFetchResult is ok when the watermark advanced", () => {
    expect(emptyFetchResult({ advanced: ok(undefined), source: "slack", warnings: ["w"] })).toEqual({
      deduped: 0,
      errors: [],
      ok: true,
      projected: 0,
      source: "slack",
      warnings: ["w"],
      written: 0,
    });
  });

  it("emptyFetchResult fails when the watermark advance failed", () => {
    const result = emptyFetchResult({ advanced: err(["wm"]), source: "slack", warnings: [] });
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["wm"]);
  });

  it("writeFailureResult keeps projected but zero written", () => {
    expect(writeFailureResult({ errors: ["io"], projected: 5, source: "notion", warnings: [] })).toEqual({
      deduped: 0,
      errors: ["io"],
      ok: false,
      projected: 5,
      source: "notion",
      warnings: [],
      written: 0,
    });
  });

  it("successfulIngestResult preserves write counts even when the watermark advance failed", () => {
    const result = successfulIngestResult({
      advanced: err(["wm"]),
      deduped: 2,
      projected: 5,
      source: "github",
      warnings: [],
      written: 3,
    });
    expect(result.ok).toBe(false);
    expect(result.written).toBe(3);
    expect(result.deduped).toBe(2);
    expect(result.errors).toEqual(["wm"]);
  });
});

/** A plain fake IngestDeps (no mocks): canned write/advance outcomes + call recorders. */
const fakeDeps = ({
  write,
  advance,
}: {
  write: Result<WriteResult>;
  advance: Result<unknown>;
}): { deps: IngestDeps; writeCalls: unknown[]; advanceCalls: unknown[] } => {
  const writeCalls: unknown[] = [];
  const advanceCalls: unknown[] = [];
  return {
    advanceCalls,
    deps: {
      advance: (args) => {
        advanceCalls.push(args);
        return advance as ReturnType<IngestDeps["advance"]>;
      },
      write: (args) => {
        writeCalls.push(args);
        return write;
      },
    },
    writeCalls,
  };
};

const ghJob = (over: Partial<SourceIngestJob> = {}): SourceIngestJob => ({
  label: "GitHub",
  run: () => Promise.resolve(ok({ records: [slackRecord], warnings: [] })),
  source: "github",
  window,
  ...over,
});

describe("ingestSources over injected seams", () => {
  it("does NOT advance the watermark when the write fails", async () => {
    const { deps, advanceCalls } = fakeDeps({ advance: ok(undefined), write: err(["disk full"]) });
    const result = unwrap(await ingestSources({ deps, home: "/h", jobs: [ghJob()] }))[0]!;
    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(["disk full"]);
    expect(advanceCalls).toHaveLength(0);
  });

  it("surfaces a watermark failure after a successful write, keeping the write counts", async () => {
    const { deps } = fakeDeps({
      advance: err(["wm io"]),
      write: ok({ bySource: { github: 1 }, deduped: 0, written: 1 }),
    });
    const result = unwrap(await ingestSources({ deps, home: "/h", jobs: [ghJob()] }))[0]!;
    expect(result.ok).toBe(false);
    expect(result.written).toBe(1);
    expect(result.errors).toEqual(["wm io"]);
  });

  it("emits start/done progress in order and one source failure does not skip the next", async () => {
    const { deps } = fakeDeps({
      advance: ok(undefined),
      write: ok({ bySource: { github: 1 }, deduped: 0, written: 1 }),
    });
    const progress: IngestProgress[] = [];
    const results = unwrap(
      await ingestSources({
        deps,
        home: "/h",
        jobs: [ghJob({ label: "A", run: () => Promise.resolve(err(["a failed"])) }), ghJob({ label: "B" })],
        onProgress: (p) => progress.push(p),
      }),
    );
    expect(results.map((r) => r.ok)).toEqual([false, true]);
    expect(progress.map((p) => `${p.phase}:${String(p.done)}`)).toEqual(["start:0", "done:1", "start:1", "done:2"]);
  });
});
