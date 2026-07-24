import { describe, expect, it } from "vitest";
import type { Profile } from "../profile.js";
import type { IdentityResolution, Person } from "../silver/identity.js";
import { ownerIdentityFromResolution } from "./ownerIdentity.js";

const profile: Profile = {
  displayName: "Ada Owner",
  gitNamespace: "ada-gh",
  id: "owner-1",
  schemaVersion: 1,
  sources: [],
};

const ownerPerson: Person = {
  confidence: "override",
  displayName: "Ada Owner",
  id: "owner-1",
  identities: [
    { handle: "ada", nativeId: "U_OWNER", source: "slack" },
    { nativeId: "ada-gh", source: "github" },
  ],
  provenance: [],
};

const resolution = (people: readonly Person[]): IdentityResolution => ({
  candidates: [],
  conflicts: [],
  index: new Map(),
  people,
});

describe("ownerIdentityFromResolution", () => {
  it("resolves the owner's cross-source handles from the person with the profile id", () => {
    const owner = ownerIdentityFromResolution({ profile, resolution: resolution([ownerPerson]) });
    expect(owner).toEqual({ handles: ["Ada Owner", "ada-gh", "U_OWNER", "ada"], personId: "owner-1" });
  });

  it("falls back to profile handles when no matching person is in the map", () => {
    const owner = ownerIdentityFromResolution({ profile, resolution: resolution([]) });
    expect(owner).toEqual({ handles: ["Ada Owner", "ada-gh"], personId: "owner-1" });
  });

  it("returns undefined when the profile has no owner id", () => {
    const owner = ownerIdentityFromResolution({ profile: { ...profile, id: "" }, resolution: resolution([]) });
    expect(owner).toBeUndefined();
  });

  it("drops empty profile fields from the handle set", () => {
    const owner = ownerIdentityFromResolution({
      profile: { ...profile, displayName: "", gitNamespace: "" },
      resolution: resolution([ownerPerson]),
    });
    expect(owner).toEqual({ handles: ["U_OWNER", "ada", "ada-gh"], personId: "owner-1" });
  });
});
