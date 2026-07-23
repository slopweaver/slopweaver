import { describe, expect, it } from "vitest";
import type { StructureBronzeRow } from "../corpus/structures/types.js";
import type { IdentityResolution } from "./identity.js";
import { buildStructureDirectory, buildStructureGraph, latestStructureRows } from "./structures.js";

const AT = "2026-07-20T00:00:00.000Z";

function row(over: Partial<StructureBronzeRow> & Pick<StructureBronzeRow, "kind" | "sourceId">): StructureBronzeRow {
  return {
    attrs: {},
    fetchedAtIso: AT,
    identity: { nativeId: over.sourceId },
    provenance: [],
    raw: {},
    relations: [],
    source: "github",
    version: 1,
    warnings: [],
    ...over,
  };
}

const TEAM = row({
  kind: "team",
  relations: [
    { targetId: "acme/app", targetKind: "repo", targetSource: "github", type: "permission" },
    { targetId: "github:octocat", targetKind: "person", targetSource: "person", type: "member" },
  ],
  sourceId: "platform",
});
const REPO = row({ kind: "repo", sourceId: "acme/app" });

describe("latestStructureRows", () => {
  it("keeps the latest row per (source, kind, sourceId)", () => {
    const older = row({ attrs: { archived: false }, kind: "repo", sourceId: "acme/app" });
    const newer = row({
      attrs: { archived: true },
      fetchedAtIso: "2026-08-01T00:00:00.000Z",
      kind: "repo",
      sourceId: "acme/app",
    });
    const latest = latestStructureRows({ rows: [older, newer] });
    expect(latest).toHaveLength(1);
    expect(latest[0]!.attrs["archived"]).toBe(true);
  });
});

describe("buildStructureDirectory", () => {
  it("groups entities by kind", () => {
    const directory = buildStructureDirectory({ rows: [TEAM, REPO] });
    expect(directory.teams.map((t) => t.id)).toEqual(["github:team:platform"]);
    expect(directory.repos.map((r) => r.id)).toEqual(["github:repo:acme/app"]);
    expect(directory.teams[0]!.relationCount).toBe(2);
  });
});

describe("buildStructureGraph", () => {
  it("emits explicit relation edges (no clique heuristic)", () => {
    const graph = buildStructureGraph({ rows: [TEAM, REPO] });
    expect(graph.edges).toEqual([
      { from: "github:team:platform", to: "github:repo:acme/app", type: "permission" },
      { from: "github:team:platform", to: "person:github:octocat", type: "member" },
    ]);
  });

  it("resolves a member edge to the canonical person when the resolution links them", () => {
    const resolution: IdentityResolution = {
      candidates: [],
      conflicts: [],
      index: new Map([["github octocat", "person-1"]]),
      people: [],
    };
    const graph = buildStructureGraph({ resolution, rows: [TEAM] });
    expect(graph.edges.find((e) => e.type === "member")!.to).toBe("person:person-1");
  });
});
