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

  it("does not flag a pre-window record stale merely because it predates the corpus window", () => {
    // An old-but-valid target, cited only by another OLD record — no recent citer, so not a live blocker.
    // A fresh unrelated record sets the corpus-newest baseline (so the old ones read as far in the past).
    const opps = spotOpportunities({
      edges: [],
      records: [
        rec({ container: "c1", sourceId: "#old", text: "done and shipped", tsIso: "2024-01-01T00:00:00Z" }),
        rec({ container: "c2", refs: ["#old"], sourceId: "#alsoOld", tsIso: "2024-01-02T00:00:00Z" }),
        rec({ container: "c3", sourceId: "#fresh", tsIso: "2026-06-01T00:00:00Z" }),
      ],
    });
    expect(opps.filter((o) => o.kind === "blocker")).toEqual([]);
  });

  it("flags a stale target only when a RECENT record still cites it (someone is waiting)", () => {
    const opps = spotOpportunities({
      edges: [],
      records: [
        rec({ container: "c1", sourceId: "#old", text: "done and shipped", tsIso: "2024-01-01T00:00:00Z" }),
        rec({ container: "c2", refs: ["#old"], sourceId: "#recent", tsIso: "2026-06-01T00:00:00Z" }),
      ],
    });
    expect(opps.filter((o) => o.kind === "blocker").map((o) => o.subject)).toEqual(["#old"]);
  });

  it("does not flag a FRESH target stale even when cited by an old record", () => {
    const opps = spotOpportunities({
      edges: [],
      records: [
        rec({ container: "c1", sourceId: "#fresh", text: "current doc", tsIso: "2026-06-10T00:00:00Z" }),
        rec({ container: "c2", refs: ["#fresh"], sourceId: "#oldCiter", tsIso: "2024-01-01T00:00:00Z" }),
      ],
    });
    expect(opps.filter((o) => o.kind === "blocker")).toEqual([]);
  });
});
