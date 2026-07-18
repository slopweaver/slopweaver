import { describe, expect, it } from "vitest";
import type { DirectoryEntry } from "../silver/directory.js";
import type { Opportunity } from "../silver/opportunity.js";
import type { SourceDigest } from "./distil.js";
import { buildGoldDocs } from "./goldIndex.js";

const person: DirectoryEntry = { id: "alice", kind: "person", recordCount: 2, sources: ["github"] };
const container: DirectoryEntry = { id: "o/r", kind: "container", recordCount: 5, sources: ["github"] };
const sourceDigest: SourceDigest = {
  containers: [
    {
      container: "o/r",
      points: [{ citations: ["pr-url"], point: "merged the login PR" }],
      source: "github",
      summary: "shipped auth",
    },
  ],
  recordCount: 5,
  source: "github",
};
const crossCut: Opportunity = {
  evidence: ["u"],
  kind: "cross-cutting",
  score: 3,
  subject: "TEAM-1",
  summary: "TEAM-1 is referenced across 3 distinct containers",
};

describe("buildGoldDocs", () => {
  const docs = buildGoldDocs({
    builtAtIso: "2024-06-01T00:00:00Z",
    containers: [container],
    opportunities: [crossCut],
    people: [person],
    sources: [sourceDigest],
  });
  const byPath = (path: string): string => docs.find((d) => d.path === path)!.markdown;

  it("renders overview, per-source, and where-to-look docs", () => {
    expect(docs.map((d) => d.path).toSorted()).toEqual(["by-source/github.md", "overview.md", "where-to-look.md"]);
  });

  it("overview names the source and the cross-cutting concern", () => {
    const overview = byPath("overview.md");
    expect(overview).toContain("**github**");
    expect(overview).toContain("TEAM-1 is referenced across 3 distinct containers");
  });

  it("by-source carries the container summary and its grounded point", () => {
    const bySource = byPath("by-source/github.md");
    expect(bySource).toContain("shipped auth");
    expect(bySource).toContain("merged the login PR");
    expect(bySource).toContain("pr-url");
  });
});
