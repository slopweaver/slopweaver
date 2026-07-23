import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { deriveSilver, planDeriveSummary } from "./derive.js";
import { buildIdentityMap, type IdentityRecord } from "./identity.js";
import { resolveFromRecords } from "./personResolver.js";

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "t",
  tsIso: "2024-06-01T00:00:00Z",
  url: "u",
  ...over,
});

const emptyMap = buildIdentityMap({ records: [] });

describe("deriveSilver", () => {
  it("builds directory + graph + opportunities from the corpus", () => {
    const artifacts = deriveSilver({
      identityMap: emptyMap,
      records: [
        rec({ author: "alice", refs: ["#42"], sourceId: "#1", url: "u1" }),
        rec({ refs: ["#42"], sourceId: "#2", url: "u2" }),
      ],
    });
    expect(artifacts.directory.people.some((p) => p.id === "alice")).toBe(true);
    expect(artifacts.graph.edges).toHaveLength(1);
    expect(Array.isArray(artifacts.opportunities)).toBe(true);
  });

  it("surfaces curated declared edges without touching the token graph (PR4.3, no re-blow)", () => {
    const artifacts = deriveSilver({
      identityMap: emptyMap,
      records: [
        rec({ attrs: { curatedEdges: ["sub-issue|linear:TEAM-2"] }, source: "linear", sourceId: "TEAM-1", url: "u1" }),
        rec({ source: "linear", sourceId: "TEAM-2", url: "u2" }),
      ],
    });
    expect(artifacts.curated.edges).toEqual([{ from: "linear:TEAM-1", kind: "sub-issue", to: "linear:TEAM-2" }]);
    // no shared token ⇒ the token clique graph stays empty; the curated edge lives only on its own graph.
    expect(artifacts.graph.edges).toEqual([]);
    expect(artifacts.curated.capped).toBe(0);
  });
});

describe("deriveSilver — identity resolution", () => {
  const records: readonly CorpusRecord[] = [
    rec({ author: "ada", source: "github", sourceId: "gh1" }),
    rec({ author: "U1", container: "slack/c", source: "slack", sourceId: "s1" }),
  ];
  const roster: readonly IdentityRecord[] = [
    {
      handle: "ada",
      id: "person:ada",
      identities: [
        { nativeId: "ada", source: "github" },
        { nativeId: "U1", source: "slack" },
      ],
      name: "Ada",
    },
  ];

  it("returns the resolution and merges it into the directory", () => {
    const resolution = resolveFromRecords({ records, roster });
    const artifacts = deriveSilver({ identityMap: emptyMap, records, resolution });
    expect(artifacts.identities.people.map((p) => p.id)).toEqual(["person:ada"]);
    expect(artifacts.directory.people).toHaveLength(1);
    expect(artifacts.directory.people[0]!.id).toBe("person:ada");
  });

  it("defaults to an empty resolution (raw ids) when none is supplied", () => {
    const artifacts = deriveSilver({ identityMap: emptyMap, records });
    expect(artifacts.identities.people).toEqual([]);
    expect(artifacts.directory.people.map((p) => p.id).toSorted()).toEqual(["U1", "ada"]);
  });
});

describe("planDeriveSummary", () => {
  it("leads with the directory/graph/opportunity counts + an identities line", () => {
    const artifacts = deriveSilver({ identityMap: emptyMap, records: [rec()] });
    const lines = planDeriveSummary({ artifacts, top: 5 });
    expect(lines[0]).toContain("directory:");
    expect(lines[1]).toContain("graph:");
    expect(lines.some((l) => l.startsWith("identities:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("curated:"))).toBe(true);
  });
});
