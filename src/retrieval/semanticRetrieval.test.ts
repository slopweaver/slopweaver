import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import type { Embedder } from "./embeddings.js";
import { fakeConceptEmbedder } from "./fakeEmbedder.js";
import { prepareSemanticContext } from "./semanticRetrieval.js";
import { inMemoryVectorCacheStore } from "./vectorIndex.js";

const records: readonly CorpusRecord[] = [
  {
    container: "o/r",
    kind: "pr",
    refs: [],
    source: "github",
    sourceId: "#1",
    text: "login token",
    tsIso: "2024-01-01T00:00:00Z",
    url: "u",
  },
];
const deps = { embedder: fakeConceptEmbedder, store: inMemoryVectorCacheStore() };

describe("prepareSemanticContext", () => {
  it("returns no context (not degraded) when disabled", async () => {
    const prep = await prepareSemanticContext({ deps, enabled: false, query: "q", records });
    expect(prep).toEqual({ degraded: false });
  });

  it("builds a context with the fake embedder", async () => {
    const prep = await prepareSemanticContext({ deps, enabled: true, query: "login", records });
    expect(prep.degraded).toBe(false);
    expect(prep.context?.queryVector).toBeDefined();
  });

  it("degrades loudly when the embedder throws", async () => {
    const warns: string[] = [];
    const broken: Embedder = {
      embedDocuments: async () => {
        throw new Error("no model");
      },
      embedQuery: async () => {
        throw new Error("no model");
      },
      modelId: "x",
    };
    const prep = await prepareSemanticContext({
      deps: { embedder: broken, store: inMemoryVectorCacheStore() },
      enabled: true,
      query: "q",
      records,
      warn: (m) => warns.push(m),
    });
    expect(prep.degraded).toBe(true);
    expect(warns[0]).toContain("falling back to BM25-only");
  });
});
