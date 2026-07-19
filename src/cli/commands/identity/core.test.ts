import { describe, expect, it } from "vitest";
import type { IdentityResolution, Person } from "../../../silver/identity.js";
import { peopleToJson, personToJson, renderPeople, renderPersonBlock } from "./core.js";

const ada: Person = {
  confidence: "override",
  displayName: "Ada Lovelace",
  id: "person:ada",
  identities: [
    { nativeId: "ada", source: "github" },
    { email: "ada@x.co", handle: "ada", nativeId: "U1", source: "slack" },
  ],
  provenance: ["override:person:ada"],
};

describe("renderPersonBlock", () => {
  it("renders a header, one line per identity, and provenance", () => {
    expect(renderPersonBlock({ person: ada })).toEqual([
      "person:ada  [override]  Ada Lovelace",
      "  github:ada",
      "  slack:U1 @ada <ada@x.co>",
      "  linked-by: override:person:ada",
    ]);
  });
});

describe("renderPeople", () => {
  it("renders one guidance line for an empty resolution", () => {
    const resolution: IdentityResolution = { candidates: [], conflicts: [], index: new Map(), people: [] };
    expect(renderPeople({ resolution })).toEqual([
      "(no identities — seed $SLOPWEAVER_HOME/identity.json or run `slopweaver refresh` first)",
    ]);
  });

  it("renders each person block then the held name candidates", () => {
    const resolution: IdentityResolution = {
      candidates: [{ confidence: "name", personIds: ["person:github:x", "person:slack:x"], reason: "name:x" }],
      conflicts: [],
      index: new Map(),
      people: [ada],
    };
    const lines = renderPeople({ resolution });
    expect(lines[0]).toBe("person:ada  [override]  Ada Lovelace");
    expect(lines.at(-1)).toBe("held name-link: person:github:x ~ person:slack:x (name:x)");
  });
});

describe("peopleToJson / personToJson", () => {
  it("shapes a person as a stable JSON value", () => {
    expect(personToJson({ person: ada })).toEqual({
      confidence: "override",
      displayName: "Ada Lovelace",
      id: "person:ada",
      identities: ada.identities,
      provenance: ["override:person:ada"],
    });
  });

  it("shapes the resolution with people + candidates + conflicts", () => {
    const resolution: IdentityResolution = {
      candidates: [],
      conflicts: ["boom"],
      index: new Map(),
      people: [ada],
    };
    expect(peopleToJson({ resolution })).toEqual({
      candidates: [],
      conflicts: ["boom"],
      people: [personToJson({ person: ada })],
    });
  });
});
