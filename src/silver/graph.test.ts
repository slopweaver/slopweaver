import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { buildCrossRefGraph, isGraphEntityToken, MAX_EDGES_PER_TOKEN } from "./graph.js";

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

  it("drops non-entity tokens (JSDoc tags, npm scopes, bare root URLs) — they form no edges", () => {
    const { edges } = buildCrossRefGraph({
      records: [
        rec({ refs: ["@param", "https://github.com"], sourceId: "#1", url: "https://github.com" }),
        rec({ refs: ["@param", "https://github.com"], sourceId: "#2", url: "https://github.com" }),
      ],
    });
    expect(edges).toEqual([]);
  });

  it("skips a hot token whose clique would exceed the hard edge cap", () => {
    // 33 records sharing one token ⇒ 33·32/2 = 528 potential edges > MAX_EDGES_PER_TOKEN (500) ⇒ skipped.
    const hot = Array.from({ length: 33 }, (_, i) => rec({ refs: ["HOT-1"], sourceId: `#${String(i)}` }));
    const { edges } = buildCrossRefGraph({ records: hot });
    expect(edges).toEqual([]);
    expect((33 * 32) / 2).toBeGreaterThan(MAX_EDGES_PER_TOKEN);
  });

  it("keeps a real entity token whose clique stays under the cap", () => {
    const under = Array.from({ length: 4 }, (_, i) => rec({ refs: ["OK-2"], sourceId: `#${String(i)}` }));
    const { edges } = buildCrossRefGraph({ records: under });
    expect(edges).toHaveLength((4 * 3) / 2); // 6 edges, all via OK-2
    expect([...new Set(edges.map((e) => e.via))]).toEqual(["OK-2"]);
  });
});

describe("isGraphEntityToken", () => {
  it("keeps ticket keys and issue/PR ids", () => {
    expect(isGraphEntityToken({ token: "TEAM-123" })).toBe(true);
    expect(isGraphEntityToken({ token: "#42" })).toBe(true);
  });

  it("keeps a real mention handle but drops JSDoc tags and npm scopes", () => {
    expect(isGraphEntityToken({ token: "@danaperson" })).toBe(true);
    expect(isGraphEntityToken({ token: "@param" })).toBe(false);
    expect(isGraphEntityToken({ token: "@octokit" })).toBe(false);
  });

  it("keeps a URL with a meaningful path but drops a bare root / boilerplate URL", () => {
    expect(isGraphEntityToken({ token: "https://github.com/o/r/pull/5" })).toBe(true);
    expect(isGraphEntityToken({ token: "https://github.com" })).toBe(false);
    expect(isGraphEntityToken({ token: "https://github.com/" })).toBe(false);
    expect(isGraphEntityToken({ token: "https://opensource.org/licenses/MIT" })).toBe(false);
  });

  it("drops an empty token and non-reference free text", () => {
    expect(isGraphEntityToken({ token: "" })).toBe(false);
    expect(isGraphEntityToken({ token: "backlog" })).toBe(false);
  });
});
