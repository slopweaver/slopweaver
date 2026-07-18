import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { err, ok, type Result, unwrap } from "../lib/result.js";
import { bronzeSourceDir } from "./corpusPaths.js";
import { readCorpusDir } from "./corpusStore.js";
import { ingestSources, type SourceIngestJob } from "./ingestSource.js";
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
