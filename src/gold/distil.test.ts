import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { unwrap } from "../lib/result.js";
import type { LlmClient } from "../llm/provider.js";
import {
  type BatchDigest,
  buildDigestPrompt,
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
