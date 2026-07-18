import { describe, expect, it } from "vitest";
import { buildIdentityMap, parseIdentityRecords, resolveHandle } from "./identity.js";

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
