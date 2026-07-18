import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { buildCrossRefGraph } from "./graph.js";

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

describe("buildCrossRefGraph", () => {
  it("links two records that share a reference token", () => {
    const { nodes, edges } = buildCrossRefGraph({
      records: [
        rec({ refs: ["TEAM-9"], sourceId: "#1", url: "u1" }),
        rec({ refs: ["TEAM-9"], sourceId: "#2", url: "u2" }),
      ],
    });
    expect(nodes).toEqual(["github:#1", "github:#2"]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ a: "github:#1", b: "github:#2", via: "TEAM-9" });
  });

  it("produces no edge for a token held by a single record", () => {
    const { edges } = buildCrossRefGraph({ records: [rec({ refs: ["ONLY-1"], url: "solo" })] });
    expect(edges).toEqual([]);
  });
});
