/**
 * The corpus contract — one source-agnostic atom every connector produces and every downstream stage
 * (dedup, graph, retrieval) consumes. Normalising all activity to ONE shape is what lets the engine
 * stay connector-count-limited rather than connector-shaped: add a source, emit `CorpusRecord`s, and
 * every later stage works unchanged.
 *
 * v0.1 ships GitHub only, so `CorpusSource` is a one-member union today; it widens as connectors land.
 *
 * PR4.5 adds ONE additive privacy axis — {@link CorpusVisibility} — carried on the OPTIONAL `visibility`
 * field. It stays a "you world model" lens, not a second store: the corpus is one broad set, and a
 * per-record `public`/`private` mark (default public; absent ⇒ public) lets a query-time scope filter
 * withhold private-lane records (Slack private channels / DMs / mpim) from a non-owner while the owner
 * still sees everything. Only {@link CorpusRecord.visibility} `=== "private"` is restrictive; a legacy
 * record written before this field reads back as public, so no fail-closed on an unparseable tag.
 */

/**
 * Origin system of a record. `github`/`slack`/`linear`/`notion` are fetched into bronze; `gold` is the
 * SYNTHETIC source for gold markdown read back as records (so distilled findings are retrievable/citable
 * alongside bronze). The union widens as connectors are added.
 */
export type CorpusSource = "github" | "slack" | "linear" | "notion" | "gold";

/**
 * A record's read scope. `public` (the default, and the read-back of any unmarked legacy record) is
 * visible to everyone; `private` is the owner-only lane — private Slack channels, DMs, and mpim group
 * DMs. Stamped at a SINGLE choke-point ({@link ../corpus/visibility.stampVisibility}) so nothing reaches
 * disk unstamped, and filtered at answer time by {@link ../retrieval/accessScope.scopeRecordsForAsker}.
 */
export type CorpusVisibility = "public" | "private";

/**
 * The sources the refresh loop fetches + watermarks. `gold` is deliberately excluded — it's synthesised
 * by the gold stage, never fetched or written to bronze. Kept as a value so callers can iterate it.
 */
export const CORPUS_SOURCES: readonly CorpusSource[] = ["github", "slack", "linear", "notion"];

/**
 * The unit a record represents, kept source-neutral so downstream stages never branch per source:
 * GitHub → `pr`/`issue`/`comment`/`review`; Slack → `message`/`comment`/`file`; Linear →
 * `issue`/`comment`/`project`/`status`; Notion → `page`/`database`/`comment`; `finding` is a gold section.
 *
 * The curated-knowledge layer (PR4.3) adds the deliberately-authored artefact kinds — `initiative`,
 * `document`, `update` (Linear); `canvas`, `bookmark`, `pin` (Slack); `discussion`, `release`,
 * `milestone`, `codeowners` (GitHub). Purely additive: pre-PR4.3 bronze never carries them.
 */
export type CorpusKind =
  | "pr"
  | "issue"
  | "comment"
  | "review"
  | "finding"
  | "message"
  | "file"
  | "page"
  | "database"
  | "status"
  | "project"
  | "initiative"
  | "document"
  | "update"
  | "canvas"
  | "bookmark"
  | "pin"
  | "discussion"
  | "release"
  | "milestone"
  | "codeowners";

/** Runtime mirror of {@link CorpusKind} for round-trip validation when reading records back. */
export const CORPUS_KINDS: readonly CorpusKind[] = [
  "pr",
  "issue",
  "comment",
  "review",
  "finding",
  "message",
  "file",
  "page",
  "database",
  "status",
  "project",
  "initiative",
  "document",
  "update",
  "canvas",
  "bookmark",
  "pin",
  "discussion",
  "release",
  "milestone",
  "codeowners",
];

/**
 * One durable unit of activity, normalised. Every field is `readonly` — records are values, never
 * mutated in place. `sourceId` is the identity key (dedup + watermark); `tsIso` drives windowing and
 * the watermark cursor; `refs` carries the cross-references that later build the graph.
 */
export interface CorpusRecord {
  /** Origin system. */
  readonly source: CorpusSource;
  /**
   * Stable per-source id — the dedup + watermark key. GitHub uses `#<number>` for the atom and
   * structured child suffixes (`#<n>:review:<i>`, `#<n>:comment:<i>`, `#<n>:state`) so a re-fetch
   * collapses onto the same ids.
   */
  readonly sourceId: string;
  /** Permalink, for citations. */
  readonly url: string;
  /** ISO-8601 timestamp of when the unit happened. Drives the export window + the per-source watermark. */
  readonly tsIso: string;
  /** What kind of unit this is. */
  readonly kind: CorpusKind;
  /** Low-cardinality grouping: for GitHub the `owner/repo`. */
  readonly container: string;
  /** Resolved author handle, when known. */
  readonly author?: string;
  /** Title, when the unit has one (PRs/issues do; comments/reviews usually don't). */
  readonly title?: string;
  /** The content. */
  readonly text: string;
  /** Cross-refs extracted from the content (`#123`, `@mentions`, URLs) — the raw material for the graph. */
  readonly refs: readonly string[];
  /**
   * Read scope (PR4.5). OPTIONAL + additive: absent ⇒ `public`, so pre-PR4.5 bronze reads back as public
   * and public records serialise byte-identically (no fingerprint churn). Only ever set to `"private"` by
   * the single {@link ../corpus/visibility.stampVisibility} choke-point (Slack private-lane records).
   */
  readonly visibility?: CorpusVisibility;
  /**
   * Rich structured metadata pulled generously from the source SDK (state, labels, reactions, assignee,
   * parent, chunk index, …) — the curated, typed, queryable subset. Deliberately NOT embedded (the vector
   * text stays title+text only) and entirely OPTIONAL: bronze written before this field parses back
   * unchanged, so it never invalidates an existing corpus. For the FULL untyped payload, see `raw`.
   */
  readonly attrs?: Readonly<Record<string, CorpusAttributeValue>>;
  /**
   * The FULL raw source payload this record was projected from (the SDK object, redacted string-leaves).
   * Stored verbatim so a future feature needing ANY source field never forces a whole-corpus re-fetch —
   * bronze is the durable capture; silver/`attrs`/`text` are the lossy projections. Opaque (never typed
   * against, never embedded, excluded from the dedup fingerprint so a volatile raw field can't churn
   * bronze). OPTIONAL + additive: pre-`raw` bronze parses back unchanged.
   */
  readonly raw?: Readonly<Record<string, unknown>>;
}

/**
 * A rich-bronze attribute value: a scalar or a list of strings. Kept deliberately narrow (no nested
 * objects) so the payload stays cheap to serialise, redact, and reason about.
 */
export type CorpusAttributeValue = string | number | boolean | readonly string[];

/** An inclusive ISO window `[since, until]` for an export. */
export interface ExportWindow {
  readonly since: string;
  readonly until: string;
}

/** Per-source incremental cursor: the max observed `tsIso`, so the next refresh resumes from there. */
export interface SourceWatermark {
  readonly source: CorpusSource;
  readonly cursor: string;
}
