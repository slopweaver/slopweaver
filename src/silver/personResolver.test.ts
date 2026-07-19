import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import type { IdentityRecord, PersonIdentity } from "./identity.js";
import {
  canonicalPersonId,
  identityCandidatesForRecord,
  normaliseName,
  personIdentityKey,
  resolveFromRecords,
  resolvePeople,
  resolvePersonForRaw,
} from "./personResolver.js";

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "t",
  tsIso: "2026-05-01T00:00:00Z",
  url: "u",
  ...over,
});

describe("identityCandidatesForRecord", () => {
  it("emits the author tagged with the record's source", () => {
    expect(identityCandidatesForRecord({ record: rec({ author: "ada", source: "slack" }) })).toEqual([
      { name: "ada", nativeId: "ada", source: "slack" },
    ]);
  });

  it("emits nothing for an author-less or gold record", () => {
    expect(identityCandidatesForRecord({ record: rec() })).toEqual([]);
    expect(identityCandidatesForRecord({ record: rec({ author: "x", source: "gold" }) })).toEqual([]);
  });
});

describe("resolvePeople — email join (high confidence)", () => {
  const candidates: readonly PersonIdentity[] = [
    { email: "ada@x.co", name: "Ada", nativeId: "ada", source: "github" },
    { email: "ADA@x.co", name: "Ada L", nativeId: "U1", source: "slack" },
  ];

  it("merges two sources sharing a normalised email into one person at 'email' confidence", () => {
    const resolution = resolvePeople({ candidates, overrides: [] });
    expect(resolution.people).toHaveLength(1);
    const person = resolution.people[0]!;
    expect(person.id).toBe("person:email:ada@x.co");
    expect(person.confidence).toBe("email");
    expect(person.identities.map((i) => i.source).toSorted()).toEqual(["github", "slack"]);
  });
});

describe("resolvePeople — name match (held, not applied)", () => {
  const candidates: readonly PersonIdentity[] = [
    { name: "Ada Lovelace", nativeId: "ada", source: "github" },
    { name: "ada  lovelace", nativeId: "U1", source: "slack" },
  ];

  it("keeps same-name cross-source identities as SEPARATE people", () => {
    const resolution = resolvePeople({ candidates, overrides: [] });
    expect(resolution.people.map((p) => p.id)).toEqual(["person:github:ada", "person:slack:u1"]);
    expect(resolution.people.every((p) => p.confidence === "single-source")).toBe(true);
  });

  it("flags the name collision as one held candidate over both people", () => {
    const resolution = resolvePeople({ candidates, overrides: [] });
    expect(resolution.candidates).toEqual([
      { confidence: "name", personIds: ["person:github:ada", "person:slack:u1"], reason: "name:ada lovelace" },
    ]);
  });

  it("does NOT index a held name link, so the directory leaves the ids raw", () => {
    const resolution = resolvePeople({ candidates, overrides: [] });
    expect(canonicalPersonId({ rawId: "ada", resolution, source: "github" })).toBe("ada");
  });
});

describe("resolvePeople — roster override always wins", () => {
  const overrides: readonly IdentityRecord[] = [
    {
      handle: "ada",
      id: "person:ada",
      identities: [
        { nativeId: "ada", source: "github" },
        { nativeId: "U1", source: "slack" },
      ],
      name: "Ada Lovelace",
    },
  ];
  // These same ids would otherwise email-merge under a DIFFERENT id — the override must win.
  const candidates: readonly PersonIdentity[] = [
    { email: "ada@x.co", nativeId: "ada", source: "github" },
    { email: "ada@x.co", nativeId: "U1", source: "slack" },
  ];

  it("pins the seeded ids to the roster person at 'override' confidence", () => {
    const resolution = resolvePeople({ candidates, overrides });
    expect(resolution.people).toHaveLength(1);
    const person = resolution.people[0]!;
    expect(person.id).toBe("person:ada");
    expect(person.confidence).toBe("override");
    expect(person.identities.map((i) => i.nativeId).toSorted()).toEqual(["U1", "ada"]);
    expect(person.provenance).toEqual(["override:person:ada"]);
  });

  it("indexes the applied override link for the directory to merge on", () => {
    const resolution = resolvePeople({ candidates, overrides });
    expect(canonicalPersonId({ rawId: "ada", resolution, source: "github" })).toBe("person:ada");
    expect(canonicalPersonId({ rawId: "U1", resolution, source: "slack" })).toBe("person:ada");
  });

  it("absorbs a free candidate that shares the roster person's email — override wins over an inferred email group", () => {
    const withEmail: readonly IdentityRecord[] = [
      {
        email: "ada@x.co",
        handle: "ada",
        id: "person:ada",
        identities: [{ nativeId: "ada", source: "github" }],
        name: "Ada",
      },
    ];
    // a Slack candidate carries the same email but is NOT listed in the roster's identities
    const resolution = resolvePeople({
      candidates: [{ email: "ADA@x.co", nativeId: "U1", source: "slack" }],
      overrides: withEmail,
    });
    expect(resolution.people).toHaveLength(1);
    const person = resolution.people[0]!;
    expect(person.id).toBe("person:ada");
    expect(person.confidence).toBe("override");
    expect(person.identities.map((i) => i.source).toSorted()).toEqual(["github", "slack"]);
    expect(person.provenance).toContain("email:ada@x.co");
  });

  it("MERGES a corpus candidate into its roster identity without losing the roster's handle", () => {
    const withHandle: readonly IdentityRecord[] = [
      {
        handle: "ada",
        id: "person:ada",
        identities: [{ handle: "ada-gh", nativeId: "ada", source: "github" }],
        name: "Ada",
      },
    ];
    // the corpus candidate for the same id carries a NAME but no handle — the roster handle must survive
    const resolution = resolvePeople({
      candidates: [{ name: "Ada L", nativeId: "ada", source: "github" }],
      overrides: withHandle,
    });
    expect(resolution.people[0]!.identities).toEqual([
      { handle: "ada-gh", name: "Ada L", nativeId: "ada", source: "github" },
    ]);
  });
});

describe("resolvePeople — single-source fallback + conflicts", () => {
  it("gives a lone identity a deterministic person:<source>:<id> key", () => {
    const resolution = resolvePeople({ candidates: [{ nativeId: "Ada", source: "github" }], overrides: [] });
    expect(resolution.people[0]!.id).toBe("person:github:ada");
    expect(resolution.people[0]!.confidence).toBe("single-source");
  });

  it("records a conflict when two roster people declare the same email (email ownership is authoritative)", () => {
    const overrides: readonly IdentityRecord[] = [
      {
        email: "shared@x.co",
        handle: "a",
        id: "person:a",
        identities: [{ nativeId: "a", source: "github" }],
        name: "A",
      },
      {
        email: "SHARED@x.co",
        handle: "b",
        id: "person:b",
        identities: [{ nativeId: "b", source: "slack" }],
        name: "B",
      },
    ];
    const resolution = resolvePeople({ candidates: [], overrides });
    expect(resolution.conflicts).toEqual(["email shared@x.co claimed by both person:a and person:b"]);
  });

  it("records a conflict when two roster people claim the same source/native id (no silent later-wins)", () => {
    const overrides: readonly IdentityRecord[] = [
      { handle: "a", id: "person:a", identities: [{ nativeId: "ada", source: "github" }], name: "A" },
      { handle: "b", id: "person:b", identities: [{ nativeId: "ada", source: "github" }], name: "B" },
    ];
    const resolution = resolvePeople({ candidates: [], overrides });
    expect(resolution.conflicts).toEqual(["identity github:ada claimed by both person:a and person:b"]);
    // person:a keeps the identity; person:b's empty shell is dropped.
    expect(resolution.people.map((p) => p.id)).toEqual(["person:a"]);
  });
});

describe("resolvePersonForRaw", () => {
  const resolution = resolvePeople({
    candidates: [],
    overrides: [
      {
        handle: "ada",
        id: "person:ada",
        identities: [
          { nativeId: "ada", source: "github" },
          { handle: "ada", nativeId: "U1", source: "slack" },
        ],
        name: "Ada Lovelace",
      },
    ],
  });

  it("resolves a raw native id (any source) to its canonical person", () => {
    expect(resolvePersonForRaw({ raw: "U1", resolution })!.id).toBe("person:ada");
    expect(resolvePersonForRaw({ raw: "@ada", resolution })!.id).toBe("person:ada");
  });

  it("returns undefined for an unknown token", () => {
    expect(resolvePersonForRaw({ raw: "nobody", resolution })).toBeUndefined();
  });
});

describe("resolveFromRecords", () => {
  it("resolves straight from corpus records + roster (merging by the seed)", () => {
    const records: readonly CorpusRecord[] = [
      rec({ author: "ada", source: "github", sourceId: "#1" }),
      rec({ author: "Ada Lovelace", container: "slack/c", source: "slack", sourceId: "s1" }),
    ];
    const roster: readonly IdentityRecord[] = [
      {
        handle: "ada",
        id: "person:ada",
        identities: [
          { nativeId: "ada", source: "github" },
          { nativeId: "Ada Lovelace", source: "slack" },
        ],
        name: "Ada Lovelace",
      },
    ];
    const resolution = resolveFromRecords({ records, roster });
    expect(resolution.people.map((p) => p.id)).toEqual(["person:ada"]);
    expect(resolution.people[0]!.identities).toHaveLength(2);
  });
});

describe("normalisers + key", () => {
  it("collapses whitespace + case in a name and builds a stable key", () => {
    expect(normaliseName({ name: "  Ada   Lovelace " })).toBe("ada lovelace");
    expect(personIdentityKey({ nativeId: "U1", source: "slack" })).toBe("slack:U1");
  });
});
