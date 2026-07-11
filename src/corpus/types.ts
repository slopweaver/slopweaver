/**
 * The corpus contract — one source-agnostic atom every connector produces and every downstream stage
 * (dedup, graph, retrieval) consumes. Normalising all activity to ONE shape is what lets the engine
 * stay connector-count-limited rather than connector-shaped: add a source, emit `CorpusRecord`s, and
 * every later stage works unchanged.
 *
 * v0.1 ships GitHub only, so `CorpusSource` is a one-member union today; it widens as connectors land.
 * There is deliberately NO visibility/ownership field — v0.1 has no private lane, so every record is
 * equally readable and the reader never has to fail-closed on an unparseable access tag.
 */

/** Origin system of a record. The discriminator; widens as connectors are added. */
export type CorpusSource = 'github'

/** The sources the refresh loop fetches + watermarks. Kept as a value so callers can iterate it. */
export const CORPUS_SOURCES: readonly CorpusSource[] = ['github']

/** The unit a record represents. GitHub produces all four; widens with new connectors. */
export type CorpusKind = 'pr' | 'issue' | 'comment' | 'review'

/** Runtime mirror of {@link CorpusKind} for round-trip validation when reading JSONL back. */
export const CORPUS_KINDS: readonly CorpusKind[] = ['pr', 'issue', 'comment', 'review']

/**
 * One durable unit of activity, normalised. Every field is `readonly` — records are values, never
 * mutated in place. `sourceId` is the identity key (dedup + watermark); `tsIso` drives windowing and
 * the watermark cursor; `refs` carries the cross-references that later build the graph.
 */
export interface CorpusRecord {
  /** Origin system. */
  readonly source: CorpusSource
  /**
   * Stable per-source id — the dedup + watermark key. GitHub uses `#<number>` for the atom and
   * structured child suffixes (`#<n>:review:<i>`, `#<n>:comment:<i>`, `#<n>:state`) so a re-fetch
   * collapses onto the same ids.
   */
  readonly sourceId: string
  /** Permalink, for citations. */
  readonly url: string
  /** ISO-8601 timestamp of when the unit happened. Drives the export window + the per-source watermark. */
  readonly tsIso: string
  /** What kind of unit this is. */
  readonly kind: CorpusKind
  /** Low-cardinality grouping: for GitHub the `owner/repo`. */
  readonly container: string
  /** Resolved author handle, when known. */
  readonly author?: string
  /** Title, when the unit has one (PRs/issues do; comments/reviews usually don't). */
  readonly title?: string
  /** The content. */
  readonly text: string
  /** Cross-refs extracted from the content (`#123`, `@mentions`, URLs) — the raw material for the graph. */
  readonly refs: readonly string[]
}

/** A point-in-time read of the corpus, with the wall-clock load time (a staleness signal for callers). */
export interface CorpusSnapshot {
  readonly records: readonly CorpusRecord[]
  readonly loadedAtMs: number
}

/** An inclusive ISO window `[since, until]` for an export. */
export interface ExportWindow {
  readonly since: string
  readonly until: string
}

/** Per-source incremental cursor: the max observed `tsIso`, so the next refresh resumes from there. */
export interface SourceWatermark {
  readonly source: CorpusSource
  readonly cursor: string
}
