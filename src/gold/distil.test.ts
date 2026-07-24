import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import type { ProgressLearning } from "../lib/progress.js";
import { unwrap } from "../lib/result.js";
import type { LlmClient } from "../llm/provider.js";
import {
  type BatchDigest,
  buildDigestPrompt,
  type DistilProgress,
  digestPointToLearning,
  distilBatch,
  distilBatches,
  reduceToSourceDigest,
  validateBatchDigest,
} from "./distil.js";
import type { DistilBatch } from "./distilGroup.js";

const rec: CorpusRecord = {
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "did a thing",
  tsIso: "2024-06-01T00:00:00Z",
  url: "u",
};
const batch: DistilBatch = { container: "o/r", hash: "h1", records: [rec], source: "github" };

const clientReturning = (input: unknown): LlmClient => ({
  complete: async () => ({ content: [{ input, type: "tool_use" }] }),
});

/** A batch with a distinct hash (so cache hits/misses are per-batch). */
const batchN = (hash: string): DistilBatch => ({ container: "o/r", hash, records: [rec], source: "github" });

/** An LlmClient that returns a valid digest and counts how many times it was called. */
function countingClient(): { client: LlmClient; calls: () => number } {
  let n = 0;
  return {
    calls: () => n,
    client: {
      complete: async () => {
        n += 1;
        return { content: [{ input: { points: [{ citations: ["u"], point: "p" }], summary: "s" }, type: "tool_use" }] };
      },
    },
  };
}

describe("validateBatchDigest", () => {
  it("keeps only cited points and drops uncited ones", () => {
    const digest = unwrap(
      validateBatchDigest({
        batch,
        input: {
          points: [
            { citations: ["u1"], point: "p1" },
            { citations: [], point: "p2" },
          ],
          summary: "s",
        },
      }),
    );
    expect(digest.points).toEqual([{ citations: ["u1"], point: "p1" }]);
  });

  it("errs when neither a summary nor a cited point survives", () => {
    expect(validateBatchDigest({ batch, input: { points: [{ citations: [], point: "p" }], summary: "" } }).ok).toBe(
      false,
    );
  });
});

describe("buildDigestPrompt", () => {
  it("includes the container and the record body", () => {
    const { user } = buildDigestPrompt({ batch });
    expect(user).toContain("Container: o/r");
    expect(user).toContain("did a thing");
  });

  it("renders a curated record's classification tag so gold can weight it (PR4.3)", () => {
    const tagged: CorpusRecord = { ...rec, attrs: { classification: "decision" }, kind: "discussion" };
    const { user } = buildDigestPrompt({ batch: { ...batch, records: [tagged] } });
    expect(user).toContain("[decision]");
  });

  it("omits the classification tag for an ordinary untagged record", () => {
    const { user } = buildDigestPrompt({ batch });
    expect(user.includes("[decision]") || user.includes("[strategy]")).toBe(false);
  });
});

describe("distilBatch", () => {
  it("returns a validated digest from the client", async () => {
    const client = clientReturning({ points: [{ citations: ["u"], point: "p" }], summary: "sum" });
    expect(unwrap(await distilBatch({ batch, client })).summary).toBe("sum");
  });
});

describe("distilBatches", () => {
  it("serves a cache hit without calling the model", async () => {
    const cached: BatchDigest = { container: "o/r", points: [], source: "github", summary: "cached" };
    const cache = new Map([["h1", cached]]);
    const throwing: LlmClient = {
      complete: async () => {
        throw new Error("should not be called");
      },
    };
    const run = await distilBatches({ batches: [batch], cache, client: throwing });
    expect(run).toMatchObject({ called: 0, hits: 1 });
    expect(run.digests[0]!.summary).toBe("cached");
  });

  it("calls the model on a cache miss and caches the result", async () => {
    const cache = new Map<string, BatchDigest>();
    const run = await distilBatches({
      batches: [batch],
      cache,
      client: clientReturning({ points: [{ citations: ["u"], point: "p" }], summary: "fresh" }),
    });
    expect(run.called).toBe(1);
    expect(cache.get("h1")!.summary).toBe("fresh");
  });

  it("fires zero model calls when maxCalls is 0 (the --dry-run guarantee)", async () => {
    const { client, calls } = countingClient();
    const run = await distilBatches({ batches: [batchN("a")], cache: new Map(), client, maxCalls: 0 });
    expect(calls()).toBe(0);
    expect(run).toMatchObject({ called: 0, skipped: 1 });
  });

  it("caps fresh calls at maxCalls and defers the rest as skipped", async () => {
    const { client, calls } = countingClient();
    const run = await distilBatches({ batches: [batchN("a"), batchN("b")], cache: new Map(), client, maxCalls: 1 });
    expect(calls()).toBe(1);
    expect(run).toMatchObject({ called: 1, skipped: 1 });
  });

  it("resumes from the persisted cache after a killed run, calling only the un-distilled batch", async () => {
    const cache = new Map<string, BatchDigest>();
    // Run 1 killed after 1 batch (maxCalls: 1) — "a" is cached, "b" deferred.
    const first = countingClient();
    await distilBatches({ batches: [batchN("a"), batchN("b")], cache, client: first.client, maxCalls: 1 });
    expect(cache.has("a")).toBe(true);
    // Run 2 resumes with the same cache: "a" is a hit, only "b" calls the model.
    const second = countingClient();
    const resume = await distilBatches({ batches: [batchN("a"), batchN("b")], cache, client: second.client });
    expect(second.calls()).toBe(1);
    expect(resume).toMatchObject({ called: 1, hits: 1, skipped: 0 });
  });

  it("checkpoints after each fresh digest so a kill loses nothing", async () => {
    let checkpoints = 0;
    const { client } = countingClient();
    await distilBatches({
      batches: [batchN("a"), batchN("b")],
      cache: new Map(),
      client,
      onCheckpoint: () => {
        checkpoints += 1;
      },
    });
    expect(checkpoints).toBe(2);
  });

  it("emits per-batch progress with running counts", async () => {
    const events: DistilProgress[] = [];
    const { client } = countingClient();
    const cache = new Map<string, BatchDigest>([
      ["a", { container: "o/r", points: [], source: "github", summary: "cached" }],
    ]);
    await distilBatches({
      batches: [batchN("a"), batchN("b")],
      cache,
      client,
      onProgress: (p) => events.push(p),
    });
    expect(events).toHaveLength(2);
    expect(events[1]).toEqual({ called: 1, done: 2, hits: 1, skipped: 0, total: 2 });
  });

  it("announces learnings ONLY for a freshly-distilled batch, never a cache hit", async () => {
    const learnings: ProgressLearning[] = [];
    const { client } = countingClient(); // fresh batch → points: [{ citations: ["u"], point: "p" }]
    const cache = new Map<string, BatchDigest>([
      [
        "a",
        {
          container: "o/r",
          points: [{ citations: ["u"], point: "cached point" }],
          source: "github",
          summary: "cached",
        },
      ],
    ]);
    await distilBatches({
      batches: [batchN("a"), batchN("b")],
      cache,
      client,
      onLearning: (l) => learnings.push(l),
    });
    expect(learnings).toEqual([{ category: "status", confidence: "low", content: "p", sourceContentId: "u" }]);
  });
});

describe("digestPointToLearning (pure)", () => {
  it("classifies by keyword and sets confidence from the citation count", () => {
    expect(digestPointToLearning({ point: { citations: ["u1", "u2", "u3"], point: "we decided to adopt X" } })).toEqual(
      {
        category: "decision",
        confidence: "high",
        content: "we decided to adopt X",
        sourceContentId: "u1",
      },
    );
    expect(digestPointToLearning({ point: { citations: ["u1", "u2"], point: "CI is failing on main" } })).toEqual({
      category: "blocker",
      confidence: "medium",
      content: "CI is failing on main",
      sourceContentId: "u1",
    });
    expect(digestPointToLearning({ point: { citations: ["u1"], point: "Ada owns the retriever" } })!.category).toBe(
      "ownership",
    );
    expect(digestPointToLearning({ point: { citations: ["u1"], point: "we should improve recall" } })!.category).toBe(
      "opportunity",
    );
    expect(digestPointToLearning({ point: { citations: ["u1"], point: "shipped v2" } })!.category).toBe("status");
  });

  it('returns undefined for an ungrounded point (no `?? ""` sentinel)', () => {
    expect(digestPointToLearning({ point: { citations: [], point: "orphan" } })).toBeUndefined();
  });
});

describe("reduceToSourceDigest", () => {
  it("orders containers by point count desc", () => {
    const thin: BatchDigest = {
      container: "a",
      points: [{ citations: ["u"], point: "p" }],
      source: "github",
      summary: "s",
    };
    const rich: BatchDigest = {
      container: "b",
      points: [
        { citations: ["u"], point: "p1" },
        { citations: ["u"], point: "p2" },
      ],
      source: "github",
      summary: "s",
    };
    const reduced = reduceToSourceDigest({ digests: [thin, rich], recordCount: 3, source: "github" });
    expect(reduced.containers.map((c) => c.container)).toEqual(["b", "a"]);
  });
});
