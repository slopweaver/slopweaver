import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import {
  cliqueSize,
  edgeForPair,
  edgesForTokenClique,
  type GraphEdge,
  indexGraphTokens,
  mergeGraphEdge,
  recordGraphNode,
  recordGraphTokens,
  shouldSkipTokenClique,
  sortGraphEdges,
} from "./graph.js";

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

describe("recordGraphNode", () => {
  it("is source:sourceId", () => {
    expect(recordGraphNode({ record: rec({ source: "slack", sourceId: "C1.123" }) })).toBe("slack:C1.123");
  });
});

describe("recordGraphTokens", () => {
  it("keeps entity refs and drops non-entity noise", () => {
    // sourceId "x1" is not entity-shaped, so it contributes no token (isolating the refs filter).
    expect(recordGraphTokens({ record: rec({ refs: ["TEAM-9", "@param"], sourceId: "x1", url: "" }) })).toEqual([
      "TEAM-9",
    ]);
  });

  it("returns [] when a record has no entity tokens", () => {
    expect(recordGraphTokens({ record: rec({ refs: [], sourceId: "x1", url: "" }) })).toEqual([]);
  });
});

describe("indexGraphTokens", () => {
  it("collects node keys and token holders in record order", () => {
    const { nodes, tokenIndex } = indexGraphTokens({
      records: [rec({ refs: ["TEAM-9"], sourceId: "#1", url: "" }), rec({ refs: ["TEAM-9"], sourceId: "#2", url: "" })],
    });
    expect([...nodes]).toEqual(["github:#1", "github:#2"]);
    expect([...tokenIndex.get("TEAM-9")!]).toEqual(["github:#1", "github:#2"]);
  });
});

describe("cliqueSize", () => {
  it("is H*(H-1)/2", () => {
    expect(cliqueSize({ holderCount: 4 })).toBe(6);
  });

  it("is 0 for a single holder", () => {
    expect(cliqueSize({ holderCount: 1 })).toBe(0);
  });
});

describe("shouldSkipTokenClique", () => {
  it("skips fewer than two holders", () => {
    expect(shouldSkipTokenClique({ holderCount: 1, potentialEdges: 0 })).toBe(true);
  });

  it("keeps a normal two-holder clique", () => {
    expect(shouldSkipTokenClique({ holderCount: 2, potentialEdges: 1 })).toBe(false);
  });

  it("skips a hub over the holder cap", () => {
    expect(shouldSkipTokenClique({ holderCount: 51, potentialEdges: 3 })).toBe(true);
  });

  it("skips a clique over the edge cap", () => {
    expect(shouldSkipTokenClique({ holderCount: 3, potentialEdges: 501 })).toBe(true);
  });
});

describe("edgeForPair", () => {
  it("orders endpoints a < b regardless of argument order", () => {
    expect(edgeForPair({ first: "z", second: "a", via: "T-1" })).toEqual({ a: "a", b: "z", via: "T-1" });
  });
});

describe("edgesForTokenClique", () => {
  it("emits every i<j pair via the token", () => {
    expect(edgesForTokenClique({ holders: ["a", "b", "c"], token: "T-1" })).toEqual([
      { a: "a", b: "b", via: "T-1" },
      { a: "a", b: "c", via: "T-1" },
      { a: "b", b: "c", via: "T-1" },
    ]);
  });

  it("emits nothing for a single holder", () => {
    expect(edgesForTokenClique({ holders: ["a"], token: "T-1" })).toEqual([]);
  });
});

describe("mergeGraphEdge", () => {
  it("keeps the lexicographically smallest via for a duplicate pair", () => {
    const edges = new Map<string, GraphEdge>();
    mergeGraphEdge({ edge: { a: "a", b: "b", via: "TEAM-9" }, edges });
    mergeGraphEdge({ edge: { a: "a", b: "b", via: "TEAM-1" }, edges });
    expect(edges.get("a b")).toEqual({ a: "a", b: "b", via: "TEAM-1" });
  });

  it("does not replace with a larger via", () => {
    const edges = new Map<string, GraphEdge>();
    mergeGraphEdge({ edge: { a: "a", b: "b", via: "TEAM-1" }, edges });
    mergeGraphEdge({ edge: { a: "a", b: "b", via: "TEAM-9" }, edges });
    expect(edges.get("a b")!.via).toBe("TEAM-1");
  });
});

describe("sortGraphEdges", () => {
  it("orders by endpoint a then b", () => {
    const edges: GraphEdge[] = [
      { a: "b", b: "c", via: "x" },
      { a: "a", b: "z", via: "y" },
      { a: "a", b: "b", via: "z" },
    ];
    expect(sortGraphEdges({ edges }).map((e) => `${e.a}-${e.b}`)).toEqual(["a-b", "a-z", "b-c"]);
  });
});
