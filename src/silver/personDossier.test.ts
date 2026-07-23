import { describe, expect, it } from "vitest";
import { memberIdentityCandidates } from "../corpus/members/project.js";
import type { MemberBronzeRow } from "../corpus/members/types.js";
import type { IdentitySource } from "./identity.js";
import { buildPersonDossiers, memberRowsByKey } from "./personDossier.js";
import { resolveFromRecords } from "./personResolver.js";

function row({
  source,
  nativeId,
  name,
  email,
  extra,
}: {
  source: IdentitySource;
  nativeId: string;
  name: string;
  email?: string;
  extra?: Partial<MemberBronzeRow["profile"]>;
}): MemberBronzeRow {
  return {
    fetchedAtIso: "2026-07-20T00:00:00.000Z",
    identity: {
      emailTrust: email !== undefined ? "trusted" : "missing",
      handle: nativeId,
      name,
      nativeId,
      source,
      ...(email !== undefined ? { email, emailNormalised: email } : {}),
    },
    profile: { active: true, bot: false, ...extra },
    provenance: [`${source}.users`],
    raw: { id: nativeId, kept: "everything" },
    source,
    sourceId: nativeId,
    version: 1,
    warnings: [],
  };
}

/** Resolve a set of member rows into people, then dossier them (the derive path, without I/O). */
function dossiersFrom({ rows }: { rows: readonly MemberBronzeRow[] }) {
  const resolution = resolveFromRecords({
    extraCandidates: memberIdentityCandidates({ rows }),
    records: [],
    roster: [],
  });
  return buildPersonDossiers({ memberRows: rows, people: resolution.people });
}

describe("memberRowsByKey", () => {
  it("indexes rows by their source:nativeId key", () => {
    const byKey = memberRowsByKey({
      rows: [row({ email: "a@example.com", name: "A", nativeId: "U1", source: "slack" })],
    });
    expect(byKey.get("slack:U1")!.identity.name).toBe("A");
  });
});

describe("buildPersonDossiers", () => {
  const rows = [
    row({
      email: "ada@example.com",
      extra: { teams: ["ENG"], timezone: "Australia/Sydney" },
      name: "Ada Lovelace",
      nativeId: "U1",
      source: "slack",
    }),
    row({ email: "ada@example.com", extra: { teams: ["PLATFORM"] }, name: "ada", nativeId: "ada", source: "github" }),
  ];

  it("aggregates one dossier per canonical person with deterministic emails/aliases/teams/attrs + raw", () => {
    const dossiers = dossiersFrom({ rows });
    expect(dossiers).toHaveLength(1);
    const dossier = dossiers[0]!;
    expect(dossier.emails).toEqual([{ sources: ["github", "slack"], trust: "trusted", value: "ada@example.com" }]);
    expect(dossier.aliases).toEqual(["Ada Lovelace", "U1", "ada"]);
    expect(dossier.teams).toEqual(["ENG", "PLATFORM"]);
    expect(dossier.timezone).toBe("Australia/Sydney");
  });

  it("keeps a copy of every raw member payload (nothing lost)", () => {
    const dossier = dossiersFrom({ rows })[0]!;
    expect(dossier.members.map((m) => m.raw)).toEqual([
      { id: "ada", kept: "everything" },
      { id: "U1", kept: "everything" },
    ]);
  });

  it("orders dossiers by person id (stable artifact)", () => {
    const dossiers = dossiersFrom({
      rows: [
        row({ email: "z@example.com", name: "Z", nativeId: "z1", source: "slack" }),
        row({ email: "a@example.com", name: "A", nativeId: "a1", source: "slack" }),
      ],
    });
    const ids = dossiers.map((d) => d.personId);
    expect(ids).toEqual(ids.toSorted());
  });
});
