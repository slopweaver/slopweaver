import { describe, expect, it } from "vitest";
import { readAttrs, readRelations, readStructureIdentity } from "./read.js";

describe("readAttrs", () => {
  it("keeps scalar + string-array values and drops non-scalars", () => {
    expect(
      readAttrs({
        value: { archived: true, count: 3, mixed: [1, "b"], name: "app", nested: { x: 1 }, tags: ["a", "b"] },
      }),
    ).toEqual({ archived: true, count: 3, name: "app", tags: ["a", "b"] });
  });

  it("returns an empty map for a non-object", () => {
    expect(readAttrs({ value: "nope" })).toEqual({});
  });
});

describe("readRelations", () => {
  it("keeps a valid relation with its attrs and drops one with an unknown type", () => {
    const relations = readRelations({
      value: [
        {
          attrs: { permission: "admin" },
          targetId: "acme/app",
          targetKind: "repo",
          targetSource: "github",
          type: "permission",
        },
        { targetId: "x", targetKind: "repo", targetSource: "github", type: "bogus" },
        { targetKind: "repo", targetSource: "github", type: "permission" },
      ],
    });
    expect(relations).toEqual([
      {
        attrs: { permission: "admin" },
        targetId: "acme/app",
        targetKind: "repo",
        targetSource: "github",
        type: "permission",
      },
    ]);
  });

  it("returns empty for a non-array", () => {
    expect(readRelations({ value: 5 })).toEqual([]);
  });
});

describe("readStructureIdentity", () => {
  it("reads the display fields and degrades a missing nativeId to an empty string", () => {
    expect(readStructureIdentity({ value: { name: "Platform", slug: "PLAT", url: "https://x/y" } })).toEqual({
      name: "Platform",
      nativeId: "",
      slug: "PLAT",
      url: "https://x/y",
    });
  });
});
