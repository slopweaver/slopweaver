/**
 * The directory: who and where the corpus is about. Pure, deterministic — a full re-scan each derive.
 * People = every record `author` plus every `@mention` in `refs`; containers = every record `container`.
 * Each entry carries how many records touch it and which sources it appears in, ranked by activity.
 */

import type { CorpusRecord, CorpusSource } from "../corpus/types.js";
import { compareStrings } from "../lib/compare.js";
import type { IdentityConfidence, IdentityResolution, Person, PersonIdentity } from "./identity.js";
import { canonicalPersonId } from "./personResolver.js";

export interface DirectoryEntry {
  readonly id: string;
  readonly kind: "person" | "container";
  readonly recordCount: number;
  readonly sources: readonly CorpusSource[];
  /** The canonical display name — present only for a person merged via an identity resolution. */
  readonly displayName?: string;
  /** The per-source ids this person owns — present only for a person merged via an identity resolution. */
  readonly identities?: readonly PersonIdentity[];
  /** How the person's identities were linked — present only for a resolved person. */
  readonly confidence?: IdentityConfidence;
  /** What linked them (provenance) — present only for a resolved person. */
  readonly provenance?: readonly string[];
}

/** The empty resolution — the default, so `buildDirectory({ records })` is behaviour-preserving. */
const EMPTY_RESOLUTION: IdentityResolution = { candidates: [], conflicts: [], index: new Map(), people: [] };

interface Tally {
  count: number;
  readonly sources: Set<CorpusSource>;
}

/** A `@mention` ref → its bare handle, or null if the ref isn't a usable mention. */
function mentionHandle({ ref }: { ref: string }): string | null {
  return ref.startsWith("@") && ref.length >= 2 ? ref.slice(1) : null;
}

/**
 * The distinct person ids a record contributes: its `author` plus every `@mention` handle in `refs`.
 * Deduped — a person named as both author and mention is counted once per record. Pure.
 *
 * @param record the corpus record
 * @returns the distinct person ids
 */
export function personIdsForRecord({ record }: { record: CorpusRecord }): readonly string[] {
  const people = new Set<string>();
  if (record.author !== undefined && record.author.length > 0) {
    people.add(record.author);
  }
  for (const ref of record.refs) {
    const handle = mentionHandle({ ref });
    if (handle !== null) {
      people.add(handle);
    }
  }
  return [...people];
}

/** Map a raw person id through the resolution to its canonical id (raw `gold`/unlinked ids pass through). */
function canonicalId({
  record,
  resolution,
  rawId,
}: {
  record: CorpusRecord;
  resolution: IdentityResolution;
  rawId: string;
}): string {
  return record.source === "gold" ? rawId : canonicalPersonId({ rawId, resolution, source: record.source });
}

/**
 * The distinct CANONICAL person ids a record contributes — {@link personIdsForRecord} mapped through the
 * identity resolution, so per-source dupes of one human collapse to a single id (deduped per record). Pure.
 *
 * @param record the corpus record
 * @param resolution the identity resolution (empty ⇒ raw ids, unchanged)
 * @returns the distinct canonical person ids
 */
export function canonicalPersonIdsForRecord({
  record,
  resolution,
}: {
  record: CorpusRecord;
  resolution: IdentityResolution;
}): readonly string[] {
  return [...new Set(personIdsForRecord({ record }).map((rawId) => canonicalId({ rawId, record, resolution })))];
}

/** The container ids a record contributes (its non-empty `container`, else none). Pure. */
export function containerIdsForRecord({ record }: { record: CorpusRecord }): readonly string[] {
  return record.container.length > 0 ? [record.container] : [];
}

/** Bump `id`'s tally, counting the record once and noting its source. */
function bump({ tallies, id, source }: { tallies: Map<string, Tally>; id: string; source: CorpusSource }): void {
  const tally = tallies.get(id) ?? { count: 0, sources: new Set<CorpusSource>() };
  tally.count += 1;
  tally.sources.add(source);
  tallies.set(id, tally);
}

/** Rank by record count desc, then id asc. */
function byRankThenId({ a, b }: { a: DirectoryEntry; b: DirectoryEntry }): number {
  return b.recordCount - a.recordCount || compareStrings({ a: a.id, b: b.id });
}

/** Turn a container tally map into sorted directory entries. */
function toContainerEntries({ tallies }: { tallies: Map<string, Tally> }): readonly DirectoryEntry[] {
  return [...tallies.entries()]
    .map(
      ([id, tally]): DirectoryEntry => ({
        id,
        kind: "container",
        recordCount: tally.count,
        sources: [...tally.sources].toSorted(),
      }),
    )
    .toSorted((a, b) => byRankThenId({ a, b }));
}

/** A person tally → a directory entry, enriched with its resolved Person metadata when one merged it. */
function toPersonEntry({
  id,
  tally,
  person,
}: {
  id: string;
  tally: Tally;
  person: Person | undefined;
}): DirectoryEntry {
  return {
    id,
    kind: "person",
    recordCount: tally.count,
    sources: [...tally.sources].toSorted(),
    ...(person !== undefined
      ? {
          confidence: person.confidence,
          displayName: person.displayName,
          identities: person.identities,
          provenance: person.provenance,
        }
      : {}),
  };
}

/** Turn a person tally map into sorted, resolution-enriched directory entries. */
function toPersonEntries({
  tallies,
  resolution,
}: {
  tallies: Map<string, Tally>;
  resolution: IdentityResolution;
}): readonly DirectoryEntry[] {
  const byId = new Map(resolution.people.map((person) => [person.id, person]));
  return [...tallies.entries()]
    .map(([id, tally]): DirectoryEntry => toPersonEntry({ id, person: byId.get(id), tally }))
    .toSorted((a, b) => byRankThenId({ a, b }));
}

/**
 * Build the people + container directory from the corpus. With an identity `resolution`, per-source
 * duplicate handles of one human collapse into a single canonical person entry (carrying its per-source
 * ids + confidence + provenance); without one, ids stay raw — behaviour-preserving.
 *
 * @param records the corpus records
 * @param resolution the cross-source identity resolution (defaults to empty ⇒ raw per-source ids)
 * @returns ranked `people` and `containers` directory entries
 */
export function buildDirectory({
  records,
  resolution = EMPTY_RESOLUTION,
}: {
  records: readonly CorpusRecord[];
  resolution?: IdentityResolution;
}): {
  people: readonly DirectoryEntry[];
  containers: readonly DirectoryEntry[];
} {
  const people = new Map<string, Tally>();
  const containers = new Map<string, Tally>();
  for (const record of records) {
    for (const container of containerIdsForRecord({ record })) {
      bump({ id: container, source: record.source, tallies: containers });
    }
    for (const person of canonicalPersonIdsForRecord({ record, resolution })) {
      bump({ id: person, source: record.source, tallies: people });
    }
  }
  return {
    containers: toContainerEntries({ tallies: containers }),
    people: toPersonEntries({ resolution, tallies: people }),
  };
}
