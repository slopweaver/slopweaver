import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../../../corpus/types.js";
import type { BatchDigest } from "../../../gold/distil.js";
import type { DistilBatch } from "../../../gold/distilGroup.js";
import { unwrap, unwrapErr } from "../../../lib/result.js";
import type { SilverIndex } from "../../../silver/silverIndexRead.js";
import {
  buildDistilWritePlan,
  completeResultLine,
  dryRunLines,
  failedResultLine,
  parseDistilOptions,
  partialResultLine,
  perSourceBatchCounts,
  planDistil,
  shouldWriteGold,
  toSourceDigests,
} from "./core.js";

const batch = ({
  source,
  container,
  hash,
}: {
  source: DistilBatch["source"];
  container: string;
  hash: string;
}): DistilBatch => ({
  container,
  hash,
  records: [],
  source,
});

const digest = ({ source, container }: { source: BatchDigest["source"]; container: string }): BatchDigest => ({
  container,
  points: [{ citations: ["u"], point: "a decision" }],
  source,
  summary: `${container} summary`,
});

const rec = (over: Partial<CorpusRecord>): CorpusRecord => ({
  container: "c",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "t",
  tsIso: "2026-01-01T00:00:00Z",
  url: "u",
  ...over,
});

describe("parseDistilOptions", () => {
  it("parses booleans + integer flags into typed options", () => {
    const parsed = unwrap(parseDistilOptions({ rest: ["--dry-run", "--max-batches", "3", "--recent-only"] }));
    expect(parsed.dryRun).toBe(true);
    expect(parsed.recentOnly).toBe(true);
    expect(parsed.maxBatches).toBe(3);
    expect(parsed.maxPerBatch).toBeUndefined();
  });

  it("errors on a non-positive integer flag", () => {
    expect(unwrapErr(parseDistilOptions({ rest: ["--max-batches", "0"] })).join(" ")).toContain("--max-batches");
  });

  it("errors on an unknown flag", () => {
    expect(parseDistilOptions({ rest: ["--bogus"] }).ok).toBe(false);
  });
});

describe("planDistil", () => {
  const batches = [
    batch({ container: "a", hash: "h1", source: "github" }),
    batch({ container: "b", hash: "h2", source: "github" }),
    batch({ container: "c", hash: "h3", source: "slack" }),
  ];

  it("counts cache hits, misses, would-call and capped", () => {
    const cache = new Map<string, BatchDigest>([["h1", digest({ container: "a", source: "github" })]]);
    const plan = planDistil({ batches, cache, maxBatches: 1 });
    expect(plan.total).toBe(3);
    expect(plan.hits).toBe(1);
    expect(plan.misses).toBe(2);
    expect(plan.wouldCall).toBe(1); // capped at maxBatches
    expect(plan.capped).toBe(1);
  });

  it("would call every miss when uncapped", () => {
    const plan = planDistil({ batches, cache: new Map(), maxBatches: undefined });
    expect(plan.wouldCall).toBe(3);
    expect(plan.capped).toBe(0);
  });
});

describe("perSourceBatchCounts + dryRunLines", () => {
  const batches = [
    batch({ container: "a", hash: "h1", source: "github" }),
    batch({ container: "b", hash: "h2", source: "github" }),
    batch({ container: "c", hash: "h3", source: "slack" }),
  ];

  it("counts batches per source, source-sorted", () => {
    expect(perSourceBatchCounts({ batches })).toEqual([
      ["github", 2],
      ["slack", 1],
    ]);
  });

  it("renders the dry-run lines with the deferred note when capped", () => {
    const plan = planDistil({ batches, cache: new Map(), maxBatches: 2 });
    const lines = dryRunLines({ maxBatches: 2, perSource: perSourceBatchCounts({ batches }), plan });
    expect(lines[0]).toBe("3 batch(es): 0 cached, 2 would call the model (1 deferred by --max-batches 2)");
    expect(lines).toContain("  github: 2 batch(es)");
    expect(lines[lines.length - 1]).toBe("dry run — no model calls, no writes");
  });

  it("omits the deferred note when uncapped", () => {
    const plan = planDistil({ batches, cache: new Map(), maxBatches: undefined });
    expect(dryRunLines({ maxBatches: undefined, perSource: [], plan })[0]).toBe(
      "3 batch(es): 0 cached, 3 would call the model",
    );
  });
});

describe("partial-output guard + report lines", () => {
  it("writes gold only when the digest set is complete (covers both deferred AND failed batches)", () => {
    expect(shouldWriteGold({ batchCount: 5, digestCount: 5 })).toBe(true); // complete
    expect(shouldWriteGold({ batchCount: 5, digestCount: 3 })).toBe(false); // 2 deferred by --max-batches
    expect(shouldWriteGold({ batchCount: 5, digestCount: 4 })).toBe(false); // 1 batch FAILED (hole in the set)
  });

  it("formats the deferred (--max-batches) partial line", () => {
    expect(partialResultLine({ called: 1, hits: 2, skipped: 3 })).toBe(
      "distilled 1 batch(es) (LLM) + 2 cached · 3 deferred by --max-batches — cache saved, gold NOT rewritten (partial). Re-run to complete.",
    );
  });

  it("formats the failed-batch incomplete line", () => {
    expect(failedResultLine({ called: 4, failed: 2, hits: 1 })).toBe(
      "distilled 4 batch(es) (LLM) + 1 cached · 2 batch(es) failed — cache saved, gold NOT rewritten (incomplete). Fix the errors and re-run to complete.",
    );
  });

  it("formats the complete-run line", () => {
    expect(completeResultLine({ called: 4, goldPath: "/wm/gold", hits: 2 })).toBe(
      "distilled 4 batch(es) (LLM) + 2 cached → gold at /wm/gold",
    );
  });
});

describe("toSourceDigests (source-digest partitioning)", () => {
  it("groups batch digests by source with per-source record counts", () => {
    const digests = [
      digest({ container: "a", source: "github" }),
      digest({ container: "b", source: "github" }),
      digest({ container: "c", source: "slack" }),
    ];
    const records = [rec({ source: "github" }), rec({ source: "github" }), rec({ source: "slack" })];
    const sourceDigests = toSourceDigests({ digests, records });
    const github = sourceDigests.find((d) => d.source === "github")!;
    expect(github.containers).toHaveLength(2);
    expect(github.recordCount).toBe(2);
  });
});

describe("buildDistilWritePlan (gold write plan)", () => {
  const silverIndex: SilverIndex = { containers: [], opportunities: [], people: [] };

  it("resolves the silver digest + gold doc file paths under home", () => {
    const sourceDigests = [
      { containers: [digest({ container: "a", source: "github" })], recordCount: 1, source: "github" as const },
    ];
    const plan = buildDistilWritePlan({
      builtAtIso: "2026-07-19T00:00:00Z",
      home: "/wm",
      silverIndex,
      sourceDigests,
    });
    expect(plan.silverDigests.map((f) => f.path)).toEqual(["/wm/corpus/silver/digests/github.json"]);
    expect(plan.goldDocs.some((f) => f.path.endsWith("overview.md"))).toBe(true);
    expect(plan.goldDocs.some((f) => f.path.endsWith("by-source/github.md"))).toBe(true);
    // The build timestamp is stamped into the overview.
    expect(plan.goldDocs.find((f) => f.path.endsWith("overview.md"))!.content).toContain("2026-07-19T00:00:00Z");
  });
});
