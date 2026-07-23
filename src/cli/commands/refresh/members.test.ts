import { describe, expect, it } from "vitest";
import { hydrateOneSource, type MemberHydrationResult, summariseMemberHydration } from "./members.js";

describe("summariseMemberHydration", () => {
  const success: MemberHydrationResult = {
    deduped: 2,
    errors: [],
    hydrated: 5,
    ok: true,
    source: "slack",
    warnings: ["no email — set the users:read.email scope for cross-source linking"],
    written: 3,
  };
  const failure: MemberHydrationResult = {
    deduped: 0,
    errors: ["notion member hydration failed: 401"],
    hydrated: 0,
    ok: false,
    source: "notion",
    warnings: [],
    written: 0,
  };

  it("emits a warn line for a member warning and an out line for a successful hydration", () => {
    expect(summariseMemberHydration({ results: [success] })).toEqual([
      { level: "warn", text: "  members slack: no email — set the users:read.email scope for cross-source linking" },
      { level: "out", text: "members slack: hydrated 5 (wrote 3 new, deduped 2)" },
    ]);
  });

  it("emits a WARN (never error) line for a hydration failure — hydration never fails the verb", () => {
    expect(summariseMemberHydration({ results: [failure] })).toEqual([
      { level: "warn", text: "  members notion: notion member hydration failed: 401" },
    ]);
  });
});

describe("hydrateOneSource (non-network branches)", () => {
  it("is a no-op for the synthetic gold source", async () => {
    expect(await hydrateOneSource({ fetchedAtIso: "t", home: "/h", source: "gold", tokens: {} })).toBeUndefined();
  });

  it("skips a source with no token (no client is ever constructed)", async () => {
    expect(await hydrateOneSource({ fetchedAtIso: "t", home: "/h", source: "slack", tokens: {} })).toBeUndefined();
  });

  it("skips GitHub when no org (repo owner) was resolved", async () => {
    expect(
      await hydrateOneSource({ fetchedAtIso: "t", home: "/h", source: "github", tokens: { github: "x" } }),
    ).toBeUndefined();
  });
});
