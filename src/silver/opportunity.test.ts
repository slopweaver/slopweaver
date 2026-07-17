import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { spotOpportunities } from "./opportunity.js";

const T = "2024-06-01T00:00:00Z";
const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "t",
  tsIso: T,
  url: "u",
  ...over,
});

describe("spotOpportunities", () => {
  it("flags a cross-cutting reference spanning ≥3 containers", () => {
    const opps = spotOpportunities({
      edges: [],
      records: [
        rec({ container: "c1", refs: ["TEAM-1"], sourceId: "#1" }),
        rec({ container: "c2", refs: ["TEAM-1"], sourceId: "#2" }),
        rec({ container: "c3", refs: ["TEAM-1"], sourceId: "#3" }),
      ],
    });
    const crossCut = opps.find((o) => o.kind === "cross-cutting" && o.subject === "TEAM-1")!;
    expect(crossCut.summary).toContain("3 distinct containers");
  });

  it("flags a referenced, unresolved item as a blocker", () => {
    const opps = spotOpportunities({
      edges: [],
      records: [
        rec({ container: "c1", sourceId: "#10", text: "this is blocked on review" }),
        rec({ container: "c2", refs: ["#10"], sourceId: "#11" }),
      ],
    });
    expect(opps.some((o) => o.kind === "blocker" && o.subject === "#10")).toBe(true);
  });

  it("does not flag duplication within a single source", () => {
    const opps = spotOpportunities({
      edges: [],
      records: [rec({ sourceId: "#1", title: "Fix login" }), rec({ sourceId: "#2", title: "Fix login" })],
    });
    expect(opps.some((o) => o.kind === "duplication")).toBe(false);
  });
});
