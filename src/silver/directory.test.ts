import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { buildDirectory } from "./directory.js";
import type { IdentityRecord } from "./identity.js";
import { resolveFromRecords } from "./personResolver.js";

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

  it("leaves ids raw when no resolution is supplied (behaviour-preserving)", () => {
    const records = [rec({ author: "ada", source: "github" }), rec({ author: "U1", source: "slack", sourceId: "s1" })];
    const { people } = buildDirectory({ records });
    expect(people.map((p) => p.id).toSorted()).toEqual(["U1", "ada"]);
  });
});

describe("buildDirectory — cross-source identity merge", () => {
  const records: readonly CorpusRecord[] = [
    rec({ author: "ada", source: "github", sourceId: "gh1" }),
    rec({ author: "U1", container: "slack/c", source: "slack", sourceId: "s1" }),
    rec({ author: "Ada Lovelace", container: "T-1", source: "linear", sourceId: "l1" }),
  ];
  const roster: readonly IdentityRecord[] = [
    {
      handle: "ada",
      id: "person:ada",
      identities: [
        { nativeId: "ada", source: "github" },
        { nativeId: "U1", source: "slack" },
        { nativeId: "Ada Lovelace", source: "linear" },
      ],
      name: "Ada Lovelace",
    },
  ];

  it("collapses N per-source dupes into ONE canonical person carrying confidence + provenance", () => {
    const resolution = resolveFromRecords({ records, roster });
    const { people } = buildDirectory({ records, resolution });
    expect(people).toHaveLength(1);
    const person = people[0]!;
    expect(person.id).toBe("person:ada");
    expect(person.recordCount).toBe(3);
    expect(person.sources).toEqual(["github", "linear", "slack"]);
    expect(person.displayName).toBe("Ada Lovelace");
    expect(person.confidence).toBe("override");
    expect(person.provenance).toEqual(["override:person:ada"]);
    expect(person.identities!.map((i) => i.source).toSorted()).toEqual(["github", "linear", "slack"]);
  });

  it("does NOT merge a low-confidence name-only match — the ids stay separate", () => {
    // no roster ⇒ same-name people across sources are HELD, never merged
    const resolution = resolveFromRecords({ records, roster: [] });
    const { people } = buildDirectory({ records, resolution });
    expect(people.map((p) => p.id).toSorted()).toEqual(["Ada Lovelace", "U1", "ada"]);
    expect(people.every((p) => p.confidence === undefined || p.confidence === "single-source")).toBe(true);
  });
});
