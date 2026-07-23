import { describe, expect, it } from "vitest";
import { encodeCuratedEdgeRef, parseCuratedEdgeRef } from "./types.js";

describe("encodeCuratedEdgeRef / parseCuratedEdgeRef", () => {
  it("round-trips a sub-issue edge to a Linear node key", () => {
    const encoded = encodeCuratedEdgeRef({ kind: "sub-issue", target: "linear:TEAM-124" });
    expect(encoded).toBe("sub-issue|linear:TEAM-124");
    expect(parseCuratedEdgeRef({ encoded })).toEqual({ kind: "sub-issue", target: "linear:TEAM-124" });
  });

  it("preserves colons in the target node key", () => {
    const encoded = encodeCuratedEdgeRef({ kind: "milestone", target: "github:#42" });
    expect(parseCuratedEdgeRef({ encoded })).toEqual({ kind: "milestone", target: "github:#42" });
  });

  it("rejects an unknown edge kind", () => {
    expect(parseCuratedEdgeRef({ encoded: "sibling|notion:page:abc" })).toBe(undefined);
  });

  it("rejects a ref with no separator", () => {
    expect(parseCuratedEdgeRef({ encoded: "relation" })).toBe(undefined);
  });

  it("rejects a ref with an empty target", () => {
    expect(parseCuratedEdgeRef({ encoded: "relation|" })).toBe(undefined);
  });
});
