import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { deriveSilver, planDeriveSummary } from "./derive.js";
import { buildIdentityMap } from "./identity.js";

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
});

describe("planDeriveSummary", () => {
  it("leads with the directory/graph/opportunity counts", () => {
    const artifacts = deriveSilver({ identityMap: emptyMap, records: [rec()] });
    const lines = planDeriveSummary({ artifacts, top: 5 });
    expect(lines[0]).toContain("directory:");
    expect(lines[1]).toContain("graph:");
  });
});
