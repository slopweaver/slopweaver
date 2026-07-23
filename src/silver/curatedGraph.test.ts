import { describe, expect, it } from "vitest";
import { CURATED_EDGES_ATTR } from "../corpus/curated/types.js";
import type { CorpusRecord } from "../corpus/types.js";
import { buildCuratedGraph, edgesForRecord, MAX_EDGES_PER_RECORD, recordEdgeRefs } from "./curatedGraph.js";
import { buildCrossRefGraph } from "./graph.js";

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  container: "c",
  kind: "issue",
  refs: [],
  source: "linear",
  sourceId: "TEAM-1",
  text: "t",
  tsIso: "2024-01-01T00:00:00Z",
  url: "u",
  ...over,
});

const withEdges = (over: Partial<CorpusRecord>, refs: readonly string[]): CorpusRecord =>
  rec({ ...over, attrs: { [CURATED_EDGES_ATTR]: refs } });

describe("recordEdgeRefs", () => {
  it("returns the encoded refs from attrs", () => {
    expect(recordEdgeRefs({ record: withEdges({}, ["sub-issue|linear:TEAM-2"]) })).toEqual(["sub-issue|linear:TEAM-2"]);
  });

  it("returns empty when attrs are absent", () => {
    expect(recordEdgeRefs({ record: rec() })).toEqual([]);
  });
});

describe("edgesForRecord", () => {
  it("parses declared edges from the holder to each target", () => {
    const result = edgesForRecord({
      record: withEdges({ source: "linear", sourceId: "TEAM-1" }, ["sub-issue|linear:TEAM-2", "blocks|linear:TEAM-3"]),
    });
    expect(result.dropped).toBe(0);
    expect(result.edges).toEqual([
      { from: "linear:TEAM-1", kind: "sub-issue", to: "linear:TEAM-2" },
      { from: "linear:TEAM-1", kind: "blocks", to: "linear:TEAM-3" },
    ]);
  });

  it("drops a self-loop and a malformed ref", () => {
    const result = edgesForRecord({
      record: withEdges({ source: "linear", sourceId: "TEAM-1" }, ["relation|linear:TEAM-1", "garbage"]),
    });
    expect(result.edges).toEqual([]);
    expect(result.dropped).toBe(0);
  });

  it("caps a runaway relation property and reports the dropped count", () => {
    const refs = Array.from({ length: MAX_EDGES_PER_RECORD + 5 }, (_, i) => `relation|notion:page:${String(i)}`);
    const result = edgesForRecord({ record: withEdges({ source: "notion", sourceId: "page:hub" }, refs) });
    expect(result.edges).toHaveLength(MAX_EDGES_PER_RECORD);
    expect(result.dropped).toBe(5);
  });
});

describe("buildCuratedGraph", () => {
  it("lifts a Notion relation into an explicit edge with both endpoints as nodes", () => {
    const records = [withEdges({ source: "notion", sourceId: "page:a" }, ["relation|notion:page:b"])];
    const graph = buildCuratedGraph({ records });
    expect(graph.edges).toEqual([{ from: "notion:page:a", kind: "relation", to: "notion:page:b" }]);
    expect(graph.nodes).toEqual(["notion:page:a", "notion:page:b"]);
    expect(graph.capped).toBe(0);
  });

  it("dedups a repeated (from,to,kind) edge and sorts deterministically", () => {
    const records = [
      withEdges({ source: "linear", sourceId: "TEAM-2" }, ["blocks|linear:TEAM-9"]),
      withEdges({ source: "linear", sourceId: "TEAM-1" }, ["sub-issue|linear:TEAM-3", "sub-issue|linear:TEAM-3"]),
    ];
    const graph = buildCuratedGraph({ records });
    expect(graph.edges).toEqual([
      { from: "linear:TEAM-1", kind: "sub-issue", to: "linear:TEAM-3" },
      { from: "linear:TEAM-2", kind: "blocks", to: "linear:TEAM-9" },
    ]);
  });

  it("accumulates the per-record cap overflow across records", () => {
    const refs = Array.from({ length: MAX_EDGES_PER_RECORD + 3 }, (_, i) => `relation|notion:page:${String(i)}`);
    const graph = buildCuratedGraph({ records: [withEdges({ source: "notion", sourceId: "page:hub" }, refs)] });
    expect(graph.capped).toBe(3);
  });
});

describe("curated edges never re-blow the cross-ref token graph", () => {
  it("leaves buildCrossRefGraph unaffected by curated-edge attrs", () => {
    // The token graph reads refs, not attrs.curatedEdges — so declaring hundreds of curated edges adds
    // ZERO token-clique edges. This is the structural guarantee that curated relations can't re-blow it.
    const refs = Array.from({ length: 400 }, (_, i) => `relation|notion:page:${String(i)}`);
    const records = [
      withEdges({ refs: [], source: "notion", sourceId: "page:hub" }, refs),
      withEdges({ refs: [], source: "notion", sourceId: "page:other" }, refs),
    ];
    expect(buildCrossRefGraph({ records }).edges).toEqual([]);
  });
});
