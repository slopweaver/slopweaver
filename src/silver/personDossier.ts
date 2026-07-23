/**
 * The consolidated silver person dossier — the richer PR10/PR18 substrate the resolver alone can't give.
 * For each canonical {@link Person} it aggregates, from the hydrated member rows the person's identities
 * point at: every email (with trust + which sources carry it), name aliases, the profile attrs
 * (timezone/title/avatar/teams + active/admin/guest/bot flags), the per-member warnings, and a copy of each
 * raw member payload (nothing lost). Pure + deterministic — sorted everywhere so the artifact is stable.
 */
import type { EmailTrust, MemberBronzeRow } from "../corpus/members/types.js";
import type { IdentityConfidence, IdentitySource, Person, PersonIdentity } from "./identity.js";
import { personIdentityKey } from "./personResolver.js";

/** One email a person carries: its normalised value, the strongest trust seen, and the sources it appears in. */
export interface DossierEmail {
  readonly value: string;
  readonly trust: EmailTrust;
  readonly sources: readonly IdentitySource[];
}

/** A raw member payload a person owns, tagged with its source + native id (loss-free capture kept in silver). */
export interface DossierMember {
  readonly source: IdentitySource;
  readonly sourceId: string;
  readonly raw: unknown;
}

/** The consolidated dossier for one canonical person. */
export interface PersonDossier {
  readonly personId: string;
  readonly displayName: string;
  readonly confidence: IdentityConfidence;
  readonly provenance: readonly string[];
  readonly identities: readonly PersonIdentity[];
  readonly emails: readonly DossierEmail[];
  readonly aliases: readonly string[];
  readonly teams: readonly string[];
  readonly timezone?: string;
  readonly title?: string;
  readonly avatarUrl?: string;
  readonly active?: boolean;
  readonly admin?: boolean;
  readonly guest?: boolean;
  readonly bot?: boolean;
  readonly warnings: readonly string[];
  readonly members: readonly DossierMember[];
}

/** Index member rows by their `<source>:<nativeId>` key (later rows win — the freshest capture). Pure. */
export function memberRowsByKey({ rows }: { rows: readonly MemberBronzeRow[] }): ReadonlyMap<string, MemberBronzeRow> {
  return new Map(rows.map((row) => [personIdentityKey({ nativeId: row.identity.nativeId, source: row.source }), row]));
}

/** The member rows a person owns, in identity-key order (deterministic). Pure. */
function membersForPerson({
  person,
  byKey,
}: {
  person: Person;
  byKey: ReadonlyMap<string, MemberBronzeRow>;
}): readonly MemberBronzeRow[] {
  return person.identities
    .map((identity) => byKey.get(personIdentityKey(identity)))
    .filter((row): row is MemberBronzeRow => row !== undefined);
}

/** The strongest of two trust tiers (`trusted` > `weak` > `missing`). Pure. */
function strongerTrust({ a, b }: { a: EmailTrust; b: EmailTrust }): EmailTrust {
  const rank: Record<EmailTrust, number> = { missing: 0, trusted: 2, weak: 1 };
  return rank[a] >= rank[b] ? a : b;
}

/** Aggregate the emails across a person's member rows, deduped by normalised value, sorted. Pure. */
function dossierEmails({ rows }: { rows: readonly MemberBronzeRow[] }): readonly DossierEmail[] {
  const byValue = new Map<string, { trust: EmailTrust; sources: Set<IdentitySource> }>();
  for (const row of rows) {
    const value = row.identity.emailNormalised;
    if (value === undefined || value.length === 0) {
      continue;
    }
    const entry = byValue.get(value) ?? { sources: new Set<IdentitySource>(), trust: "missing" };
    entry.trust = strongerTrust({ a: entry.trust, b: row.identity.emailTrust });
    entry.sources.add(row.source);
    byValue.set(value, entry);
  }
  return [...byValue.entries()]
    .map(([value, entry]): DossierEmail => ({ sources: [...entry.sources].toSorted(), trust: entry.trust, value }))
    .toSorted((a, b) => a.value.localeCompare(b.value));
}

/** The distinct display names (identity names/handles + member names) a person carries, sorted. Pure. */
function dossierAliases({ person, rows }: { person: Person; rows: readonly MemberBronzeRow[] }): readonly string[] {
  const names = new Set<string>();
  for (const identity of person.identities) {
    if (identity.name !== undefined) {
      names.add(identity.name);
    }
    if (identity.handle !== undefined) {
      names.add(identity.handle);
    }
  }
  for (const row of rows) {
    if (row.identity.name !== undefined) {
      names.add(row.identity.name);
    }
  }
  return [...names].toSorted();
}

/** The union of team keys across a person's member rows, sorted. Pure. */
function dossierTeams({ rows }: { rows: readonly MemberBronzeRow[] }): readonly string[] {
  return [...new Set(rows.flatMap((row) => row.profile.teams ?? []))].toSorted();
}

/** The first non-empty scalar profile field across rows (deterministic — rows are identity-key ordered). */
function firstScalar({
  rows,
  pick,
}: {
  rows: readonly MemberBronzeRow[];
  pick: (row: MemberBronzeRow) => string | undefined;
}): string | undefined {
  for (const row of rows) {
    const value = pick(row);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/** The OR of a boolean flag across rows (present only when at least one row set it). Pure. */
function anyFlag({
  rows,
  pick,
}: {
  rows: readonly MemberBronzeRow[];
  pick: (row: MemberBronzeRow) => boolean | undefined;
}): boolean | undefined {
  const values = rows.map(pick).filter((value): value is boolean => value !== undefined);
  return values.length > 0 ? values.some((value) => value) : undefined;
}

/** Build one person's dossier from the person + its member rows. Pure. */
function toDossier({ person, rows }: { person: Person; rows: readonly MemberBronzeRow[] }): PersonDossier {
  const timezone = firstScalar({ pick: (row) => row.profile.timezone, rows });
  const title = firstScalar({ pick: (row) => row.profile.title, rows });
  const avatarUrl = firstScalar({ pick: (row) => row.profile.avatarUrl, rows });
  const active = anyFlag({ pick: (row) => row.profile.active, rows });
  const admin = anyFlag({ pick: (row) => row.profile.admin, rows });
  const guest = anyFlag({ pick: (row) => row.profile.guest, rows });
  const bot = anyFlag({ pick: (row) => row.profile.bot, rows });
  return {
    aliases: dossierAliases({ person, rows }),
    confidence: person.confidence,
    displayName: person.displayName,
    emails: dossierEmails({ rows }),
    identities: person.identities,
    members: rows.map((row) => ({ raw: row.raw, source: row.source, sourceId: row.sourceId })),
    personId: person.id,
    provenance: person.provenance,
    teams: dossierTeams({ rows }),
    warnings: [...new Set(rows.flatMap((row) => row.warnings))].toSorted(),
    ...(timezone !== undefined ? { timezone } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(avatarUrl !== undefined ? { avatarUrl } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(admin !== undefined ? { admin } : {}),
    ...(guest !== undefined ? { guest } : {}),
    ...(bot !== undefined ? { bot } : {}),
  };
}

/**
 * Build the consolidated dossiers for every canonical person, aggregating the hydrated member rows their
 * identities point at. Deterministic (person-id order). Pure.
 *
 * @param people the canonical people (from the resolution)
 * @param memberRows the hydrated member rows across all sources
 * @returns one dossier per person, ordered by person id
 */
export function buildPersonDossiers({
  people,
  memberRows,
}: {
  people: readonly Person[];
  memberRows: readonly MemberBronzeRow[];
}): readonly PersonDossier[] {
  const byKey = memberRowsByKey({ rows: memberRows });
  return people
    .map((person) => toDossier({ person, rows: membersForPerson({ byKey, person }) }))
    .toSorted((a, b) => a.personId.localeCompare(b.personId));
}
