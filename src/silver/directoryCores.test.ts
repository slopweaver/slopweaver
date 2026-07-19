import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { containerIdsForRecord, personIdsForRecord } from "./directory.js";

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

describe("personIdsForRecord", () => {
  it("includes the author and every @mention handle", () => {
    expect(personIdsForRecord({ record: rec({ author: "alice", refs: ["@bob", "@carol"] }) })).toEqual([
      "alice",
      "bob",
      "carol",
    ]);
  });

  it("counts a person once when author and mention coincide", () => {
    expect(personIdsForRecord({ record: rec({ author: "alice", refs: ["@alice"] }) })).toEqual(["alice"]);
  });

  it("returns [] when there is no author and no mention", () => {
    expect(personIdsForRecord({ record: rec({ refs: ["TEAM-9"] }) })).toEqual([]);
  });

  it("ignores an empty author", () => {
    expect(personIdsForRecord({ record: rec({ author: "" }) })).toEqual([]);
  });

  it("ignores a bare @ ref", () => {
    expect(personIdsForRecord({ record: rec({ refs: ["@"] }) })).toEqual([]);
  });
});

describe("containerIdsForRecord", () => {
  it("returns the non-empty container", () => {
    expect(containerIdsForRecord({ record: rec({ container: "team/repo" }) })).toEqual(["team/repo"]);
  });

  it("returns [] for an empty container", () => {
    expect(containerIdsForRecord({ record: rec({ container: "" }) })).toEqual([]);
  });
});
