/**
 * The pure cross-source person resolver: turn a stream of per-source {@link PersonIdentity} candidates
 * (extracted from the corpus) plus the human roster into a set of canonical {@link Person}s, each owning
 * its per-source ids with a resolution confidence + provenance. Deterministic grouping, no I/O, no deps —
 * a hand-roll is justified under D21 (there is no infra-free library for "group these identities").
 *
 * The link order is data-first (D8) and STRICTLY prioritised, strongest first:
 *   1. `override`  — a roster entry pins these source/native ids to one Person. Always wins.
 *   2. `email`     — free candidates sharing a trusted normalised email merge (high confidence).
 *   3. `handle`    — free candidates sharing an unambiguous normalised handle merge.
 *   4. `name`      — a same-name match is HELD as a candidate, NEVER auto-merged (names collide).
 *   5. `single-source` — the fallback: one Person per source/native id.
 * Low-confidence (name) links are surfaced, not applied; only override/email/handle links are indexed for
 * the directory to merge on, so an unlinked id keeps its raw form (behaviour-preserving).
 */
import type { CorpusRecord } from "../corpus/types.js";
import type {
  IdentityConfidence,
  IdentityLinkCandidate,
  IdentityRecord,
  IdentityResolution,
  IdentitySource,
  Person,
  PersonIdentity,
} from "./identity.js";

/** The `<source>:<nativeId>` index key for a source-native identity. Pure. */
export function personIdentityKey({ source, nativeId }: { source: IdentitySource; nativeId: string }): string {
  return `${source}:${nativeId}`;
}

/** Lower-case + trim an email for joining. Pure. */
export function normaliseEmail({ email }: { email: string }): string {
  return email.trim().toLowerCase();
}

/** Strip a leading `@`, then lower-case + trim a handle/native id for joining. Pure. */
export function normaliseHandle({ handle }: { handle: string }): string {
  return (handle.startsWith("@") ? handle.slice(1) : handle).trim().toLowerCase();
}

/** Lower-case, trim, and collapse internal whitespace in a display name for comparison. Pure. */
export function normaliseName({ name }: { name: string }): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * The per-source identity a record contributes: its `author`, tagged with the record's source. The
 * synthetic `gold` source and author-less records contribute nothing. Pure.
 *
 * @param record the corpus record
 * @returns the record's person identities (0 or 1)
 */
export function identityCandidatesForRecord({ record }: { record: CorpusRecord }): readonly PersonIdentity[] {
  if (record.source === "gold" || record.author === undefined || record.author.length === 0) {
    return [];
  }
  return [{ name: record.author, nativeId: record.author, source: record.source }];
}

/** A mutable person under construction — deduped identities + a provenance set, frozen to a {@link Person} later. */
interface Builder {
  readonly id: string;
  readonly displayName: string;
  readonly confidence: IdentityConfidence;
  readonly provenance: Set<string>;
  readonly identities: Map<string, PersonIdentity>;
}

/** The best display name for a candidate: name → handle → native id. */
function displayNameFor({ candidate }: { candidate: PersonIdentity }): string {
  return candidate.name ?? candidate.handle ?? candidate.nativeId;
}

/** Union two identities of the same key — the first-seen (roster) fields win, gaps filled by the incoming. */
function mergeIdentity({ existing, incoming }: { existing: PersonIdentity; incoming: PersonIdentity }): PersonIdentity {
  const handle = existing.handle ?? incoming.handle;
  const name = existing.name ?? incoming.name;
  const email = existing.email ?? incoming.email;
  return {
    nativeId: existing.nativeId,
    source: existing.source,
    ...(handle !== undefined ? { handle } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

/** Add an identity to a builder, deduped by its index key — a same-key identity MERGES fields (never
 * overwrites), so a roster-provided handle/email isn't lost when a corpus candidate for the same id arrives. */
function addIdentity({ builder, identity }: { builder: Builder; identity: PersonIdentity }): void {
  const key = personIdentityKey(identity);
  const existing = builder.identities.get(key);
  builder.identities.set(key, existing === undefined ? identity : mergeIdentity({ existing, incoming: identity }));
}

/** A fresh builder for a canonical person. */
function newBuilder({
  id,
  displayName,
  confidence,
}: {
  id: string;
  displayName: string;
  confidence: IdentityConfidence;
}): Builder {
  return { confidence, displayName, id, identities: new Map(), provenance: new Set() };
}

/**
 * Register a roster person's emails (top-level + per-identity) as owned, so a free email-match absorbs into
 * it. Email ownership is authoritative (it wins over inferred links), so an email claimed by two DIFFERENT
 * roster people is a conflict — recorded (first-wins the map, not silently later-wins), like a dup id.
 */
function claimEmails({
  emailToId,
  emails,
  id,
  conflicts,
}: {
  emailToId: Map<string, string>;
  emails: readonly (string | undefined)[];
  id: string;
  conflicts: string[];
}): void {
  for (const email of emails) {
    if (email !== undefined && email.length > 0) {
      const norm = normaliseEmail({ email });
      const owner = emailToId.get(norm);
      if (owner === undefined) {
        emailToId.set(norm, id);
      } else if (owner !== id) {
        conflicts.push(`email ${norm} claimed by both ${owner} and ${id}`);
      }
    }
  }
}

/**
 * Seed builders from the roster: every entry carrying `identities[]` becomes (or extends) a Person whose
 * source/native ids (and declared emails) are pinned to its `id` at `override` confidence. A source/native
 * id claimed by two different roster people is a conflict (recorded, not silently later-wins).
 */
function rosterBuilders({ overrides }: { overrides: readonly IdentityRecord[] }): {
  builders: Map<string, Builder>;
  keyToId: Map<string, string>;
  emailToId: Map<string, string>;
  conflicts: string[];
} {
  const builders = new Map<string, Builder>();
  const keyToId = new Map<string, string>();
  const emailToId = new Map<string, string>();
  const conflicts: string[] = [];
  for (const override of overrides) {
    const identities = override.identities ?? [];
    if (identities.length === 0) {
      continue;
    }
    const builder =
      builders.get(override.id) ?? newBuilder({ confidence: "override", displayName: override.name, id: override.id });
    builders.set(override.id, builder);
    builder.provenance.add(`override:${override.id}`);
    claimEmails({ conflicts, emails: [override.email, ...identities.map((i) => i.email)], emailToId, id: override.id });
    for (const identity of identities) {
      const key = personIdentityKey(identity);
      const claimed = keyToId.get(key);
      if (claimed !== undefined && claimed !== override.id) {
        conflicts.push(`identity ${key} claimed by both ${claimed} and ${override.id}`);
        continue;
      }
      keyToId.set(key, override.id);
      addIdentity({ builder, identity });
    }
  }
  return { builders, conflicts, emailToId, keyToId };
}

/** Classify a non-roster candidate into its merge group + the confidence tier that groups it. */
function classifyFree({ candidate }: { candidate: PersonIdentity }): {
  groupId: string;
  confidence: IdentityConfidence;
  reason: string;
} {
  if (candidate.email !== undefined) {
    const email = normaliseEmail({ email: candidate.email });
    return { confidence: "email", groupId: `person:email:${email}`, reason: `email:${email}` };
  }
  if (candidate.handle !== undefined) {
    const handle = normaliseHandle({ handle: candidate.handle });
    return { confidence: "handle", groupId: `person:handle:${handle}`, reason: `handle:${handle}` };
  }
  const native = normaliseHandle({ handle: candidate.nativeId });
  return { confidence: "single-source", groupId: `person:${candidate.source}:${native}`, reason: "single-source" };
}

/** The roster person that OWNS a candidate's email, if any — so the override wins over an inferred email group. */
function rosterEmailOwner({
  emailToId,
  candidate,
}: {
  emailToId: Map<string, string>;
  candidate: PersonIdentity;
}): string | undefined {
  return candidate.email !== undefined ? emailToId.get(normaliseEmail({ email: candidate.email })) : undefined;
}

/** Fold one free candidate into the builders: join its roster person (by id OR by owned email) if any, else its inferred group. */
function addFree({
  builders,
  keyToId,
  emailToId,
  candidate,
}: {
  builders: Map<string, Builder>;
  keyToId: Map<string, string>;
  emailToId: Map<string, string>;
  candidate: PersonIdentity;
}): void {
  const key = personIdentityKey(candidate);
  const byKey = keyToId.get(key);
  const byEmail = byKey === undefined ? rosterEmailOwner({ candidate, emailToId }) : undefined;
  const owner = byKey ?? byEmail;
  if (owner !== undefined) {
    const builder = builders.get(owner)!;
    if (byEmail !== undefined && candidate.email !== undefined) {
      builder.provenance.add(`email:${normaliseEmail({ email: candidate.email })}`);
    }
    keyToId.set(key, owner);
    addIdentity({ builder, identity: candidate });
    return;
  }
  const { groupId, confidence, reason } = classifyFree({ candidate });
  const builder =
    builders.get(groupId) ?? newBuilder({ confidence, displayName: displayNameFor({ candidate }), id: groupId });
  builders.set(groupId, builder);
  builder.provenance.add(reason);
  keyToId.set(key, groupId);
  addIdentity({ builder, identity: candidate });
}

/** Freeze a builder into a Person with deterministically ordered identities + provenance. */
function toPerson({ builder }: { builder: Builder }): Person {
  return {
    confidence: builder.confidence,
    displayName: builder.displayName,
    id: builder.id,
    identities: [...builder.identities.values()].toSorted((a, b) =>
      personIdentityKey(a).localeCompare(personIdentityKey(b)),
    ),
    provenance: [...builder.provenance].toSorted(),
  };
}

/** The distinct normalised names a person carries across its identities. */
function personNames({ person }: { person: Person }): readonly string[] {
  return [
    ...new Set(person.identities.flatMap((i) => (i.name !== undefined ? [normaliseName({ name: i.name })] : []))),
  ];
}

/**
 * Same-name links across DIFFERENT people, HELD not applied: for each normalised name owned by more than
 * one canonical person, one candidate listing them. Deterministically ordered.
 */
function nameCandidates({ people }: { people: readonly Person[] }): readonly IdentityLinkCandidate[] {
  const byName = new Map<string, Set<string>>();
  for (const person of people) {
    for (const name of personNames({ person })) {
      byName.set(name, (byName.get(name) ?? new Set()).add(person.id));
    }
  }
  const candidates: IdentityLinkCandidate[] = [];
  for (const [name, ids] of byName) {
    if (ids.size > 1) {
      candidates.push({ confidence: "name", personIds: [...ids].toSorted(), reason: `name:${name}` });
    }
  }
  return candidates.toSorted((a, b) => a.reason.localeCompare(b.reason));
}

/** The index of only APPLIED cross-source links (override/email/handle) — a single-source id is left raw. */
function appliedIndex({
  keyToId,
  people,
}: {
  keyToId: Map<string, string>;
  people: readonly Person[];
}): ReadonlyMap<string, string> {
  const linked = new Set(people.filter((p) => p.confidence !== "single-source").map((p) => p.id));
  return new Map([...keyToId].filter(([, id]) => linked.has(id)));
}

/**
 * Resolve per-source identity candidates + the roster into canonical people. Deterministic + pure.
 *
 * @param candidates the per-source identities discovered in the corpus (see {@link identityCandidatesForRecord})
 * @param overrides the parsed roster (the human seed/override that always wins)
 * @returns the canonical people, held name candidates, roster conflicts, and the applied-link index
 */
export function resolvePeople({
  candidates,
  overrides,
}: {
  candidates: readonly PersonIdentity[];
  overrides: readonly IdentityRecord[];
}): IdentityResolution {
  const { builders, keyToId, emailToId, conflicts } = rosterBuilders({ overrides });
  for (const candidate of candidates) {
    addFree({ builders, candidate, emailToId, keyToId });
  }
  // A roster entry whose every identity lost a conflict contributes no identities — drop the empty shell.
  const people = [...builders.values()]
    .filter((builder) => builder.identities.size > 0)
    .map((builder) => toPerson({ builder }))
    .toSorted((a, b) => a.id.localeCompare(b.id));
  return { candidates: nameCandidates({ people }), conflicts, index: appliedIndex({ keyToId, people }), people };
}

/**
 * Resolve straight from a corpus + roster — the common wiring both `derive` and the `identity` verb use.
 * Pure orchestration over {@link identityCandidatesForRecord} + {@link resolvePeople}.
 *
 * @param records the corpus records to discover per-source identities from
 * @param roster the parsed roster (the human seed/override)
 * @returns the cross-source identity resolution
 */
export function resolveFromRecords({
  records,
  roster,
}: {
  records: readonly CorpusRecord[];
  roster: readonly IdentityRecord[];
}): IdentityResolution {
  return resolvePeople({
    candidates: records.flatMap((record) => identityCandidatesForRecord({ record })),
    overrides: roster,
  });
}

/**
 * The canonical person id for a raw source-native id — used by the directory to MERGE per-source dupes.
 * Only APPLIED cross-source links map; an unlinked id returns unchanged (behaviour-preserving).
 *
 * @param resolution the resolution
 * @param source the record's source
 * @param rawId the raw author/handle
 * @returns the canonical person id, or `rawId` when it carries no applied link
 */
export function canonicalPersonId({
  resolution,
  source,
  rawId,
}: {
  resolution: IdentityResolution;
  source: IdentitySource;
  rawId: string;
}): string {
  return resolution.index.get(personIdentityKey({ nativeId: rawId, source })) ?? rawId;
}

/** Whether an identity matches a normalised needle by native id, handle, or name. */
function identityMatches({ identity, needle }: { identity: PersonIdentity; needle: string }): boolean {
  return (
    normaliseHandle({ handle: identity.nativeId }) === needle ||
    (identity.handle !== undefined && normaliseHandle({ handle: identity.handle }) === needle) ||
    (identity.name !== undefined && normaliseName({ name: identity.name }) === needle)
  );
}

/**
 * Find the canonical Person a raw handle/id belongs to — the `identity resolve` lookup. Prefers an exact
 * `(source, nativeId)` index hit, else scans every identity for a native-id/handle/name match. Pure.
 *
 * @param resolution the resolution
 * @param raw the raw token (with or without a leading `@`)
 * @param source narrow the exact-hit lookup to one source (optional)
 * @returns the owning Person, or `undefined` when unknown
 */
export function resolvePersonForRaw({
  resolution,
  raw,
  source,
}: {
  resolution: IdentityResolution;
  raw: string;
  source?: IdentitySource;
}): Person | undefined {
  const bare = raw.startsWith("@") ? raw.slice(1) : raw;
  if (source !== undefined) {
    const id = resolution.index.get(personIdentityKey({ nativeId: bare, source }));
    const hit = id !== undefined ? resolution.people.find((p) => p.id === id) : undefined;
    if (hit !== undefined) {
      return hit;
    }
  }
  const needle = normaliseHandle({ handle: bare });
  return resolution.people.find((p) => p.identities.some((identity) => identityMatches({ identity, needle })));
}
