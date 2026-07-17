import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { buildDirectory } from "./directory.js";

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

describe("buildDirectory", () => {
  it("tallies people from authors + @mentions, and containers, ranked by record count", () => {
    const { people, containers } = buildDirectory({
      records: [rec({ author: "alice", refs: ["@bob"], sourceId: "#1" }), rec({ author: "alice", sourceId: "#2" })],
    });
    expect(people.find((p) => p.id === "alice")!.recordCount).toBe(2);
    expect(people.find((p) => p.id === "bob")!.recordCount).toBe(1);
    expect(people[0]!.id).toBe("alice"); // ranked first
    expect(containers.find((c) => c.id === "o/r")!.recordCount).toBe(2);
  });

  it("counts a person at most once per record", () => {
    const { people } = buildDirectory({ records: [rec({ author: "alice", refs: ["@alice"] })] });
    expect(people.find((p) => p.id === "alice")!.recordCount).toBe(1);
  });
});
