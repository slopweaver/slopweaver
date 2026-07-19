import { describe, expect, it } from "vitest";
import { buildIdentityMap, parseIdentityRecords, parsePersonIdentity, resolveHandle } from "./identity.js";

describe("parseIdentityRecords", () => {
  it("parses records and defaults handle/name", () => {
    expect(parseIdentityRecords({ content: '[{"id":"U1","handle":"nick","name":"Nick"},{"id":"U2"}]' })).toEqual([
      { handle: "nick", id: "U1", name: "Nick" },
      { handle: "U2", id: "U2", name: "U2" },
    ]);
  });

  it("returns [] for unparseable content", () => {
    expect(parseIdentityRecords({ content: "not json" })).toEqual([]);
  });

  it("parses the optional cross-source email + identities (the PR4 override)", () => {
    const content = JSON.stringify([
      {
        email: "ada@x.co",
        handle: "ada",
        id: "person:ada",
        identities: [
          { nativeId: "ada", source: "github" },
          { handle: "ada", nativeId: "U1", source: "slack" },
        ],
        name: "Ada Lovelace",
      },
    ]);
    expect(parseIdentityRecords({ content })).toEqual([
      {
        email: "ada@x.co",
        handle: "ada",
        id: "person:ada",
        identities: [
          { nativeId: "ada", source: "github" },
          { handle: "ada", nativeId: "U1", source: "slack" },
        ],
        name: "Ada Lovelace",
      },
    ]);
  });

  it("skips a malformed identity element without dropping the whole entry", () => {
    const content = JSON.stringify([
      {
        id: "person:ada",
        identities: [
          { nativeId: "ada", source: "github" },
          { nativeId: "", source: "slack" }, // empty nativeId → dropped
          { nativeId: "x", source: "jira" }, // unknown source → dropped
        ],
      },
    ]);
    const parsed = parseIdentityRecords({ content });
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.identities).toEqual([{ nativeId: "ada", source: "github" }]);
  });
});

describe("parsePersonIdentity", () => {
  it("requires a known source and a non-empty nativeId", () => {
    expect(parsePersonIdentity({ entry: { nativeId: "ada", source: "github" } })).toEqual({
      nativeId: "ada",
      source: "github",
    });
    expect(parsePersonIdentity({ entry: { nativeId: "ada", source: "gold" } })).toBeUndefined();
    expect(parsePersonIdentity({ entry: { nativeId: "", source: "slack" } })).toBeUndefined();
    expect(parsePersonIdentity({ entry: "nope" })).toBeUndefined();
  });
});

describe("resolveHandle", () => {
  const map = buildIdentityMap({ records: [{ handle: "nick", id: "U1", name: "Nick" }] });

  it("resolves a known id to @handle", () => {
    expect(resolveHandle({ map, raw: "@U1" })).toBe("@nick");
  });

  it("passes an unknown handle through verbatim", () => {
    expect(resolveHandle({ map, raw: "@alice" })).toBe("@alice");
  });
});
