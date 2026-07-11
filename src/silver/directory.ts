/**
 * The directory: who and where the corpus is about. Pure, deterministic — a full re-scan each derive.
 * People = every record `author` plus every `@mention` in `refs`; containers = every record `container`.
 * Each entry carries how many records touch it and which sources it appears in, ranked by activity.
 */
import type { CorpusRecord, CorpusSource } from '../corpus/types.js'

export interface DirectoryEntry {
  readonly id: string
  readonly kind: 'person' | 'container'
  readonly recordCount: number
  readonly sources: readonly CorpusSource[]
}

interface Tally {
  count: number
  readonly sources: Set<CorpusSource>
}

/** A `@mention` ref → its bare handle, or null if the ref isn't a usable mention. */
function mentionHandle({ ref }: { ref: string }): string | null {
  return ref.startsWith('@') && ref.length >= 2 ? ref.slice(1) : null
}

/** Bump `id`'s tally, counting the record once and noting its source. */
function bump({ tallies, id, source }: { tallies: Map<string, Tally>; id: string; source: CorpusSource }): void {
  const tally = tallies.get(id) ?? { count: 0, sources: new Set<CorpusSource>() }
  tally.count += 1
  tally.sources.add(source)
  tallies.set(id, tally)
}

/** Rank by record count desc, then id asc. */
function byRankThenId({ a, b }: { a: DirectoryEntry; b: DirectoryEntry }): number {
  return b.recordCount - a.recordCount || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Turn a tally map into sorted directory entries of one kind. */
function toEntries({ tallies, kind }: { tallies: Map<string, Tally>; kind: 'person' | 'container' }): readonly DirectoryEntry[] {
  return [...tallies.entries()]
    .map(([id, tally]): DirectoryEntry => ({ id, kind, recordCount: tally.count, sources: [...tally.sources].sort() }))
    .sort((a, b) => byRankThenId({ a, b }))
}

/**
 * Build the people + container directory from the corpus.
 *
 * @param records the corpus records
 * @returns ranked `people` and `containers` directory entries
 */
export function buildDirectory({ records }: { records: readonly CorpusRecord[] }): {
  people: readonly DirectoryEntry[]
  containers: readonly DirectoryEntry[]
} {
  const people = new Map<string, Tally>()
  const containers = new Map<string, Tally>()
  for (const record of records) {
    if (record.container.length > 0) {
      bump({ tallies: containers, id: record.container, source: record.source })
    }
    const seenPeople = new Set<string>()
    if (record.author !== undefined && record.author.length > 0) {
      seenPeople.add(record.author)
    }
    for (const ref of record.refs) {
      const handle = mentionHandle({ ref })
      if (handle !== null) {
        seenPeople.add(handle)
      }
    }
    for (const person of seenPeople) {
      bump({ tallies: people, id: person, source: record.source })
    }
  }
  return { people: toEntries({ tallies: people, kind: 'person' }), containers: toEntries({ tallies: containers, kind: 'container' }) }
}
