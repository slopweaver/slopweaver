/**
 * The structure-bronze contract — one durable row per organisational entity (an org/workspace, a team, a
 * repo, a channel, a usergroup, a workflow-state, a cycle, a data-source schema) captured by the structural
 * hydration pass across GitHub/Slack/Linear/Notion and persisted under `$SLOPWEAVER_HOME/corpus/structures/`.
 *
 * Unlike a {@link ../types.CorpusRecord} (activity), a structure row is the SCAFFOLDING the activity happens
 * inside: it carries the entity's native id + display fields + descriptive attrs + typed relations (team↔
 * member, repo↔team, state↔team, …) + the FULL raw SDK payload (nothing projected away, mirroring member
 * bronze). It never enters the record reader / retrieval / embeddings — it surfaces only into the silver
 * directory/graph so belief + review-routing can reason about ownership and boundaries.
 */
import type { IdentitySource } from "../../silver/identity.js";

/** The kinds of organisational entity a structure row can describe. */
export type StructureKind =
  | "org"
  | "team"
  | "repo"
  | "channel"
  | "usergroup"
  | "workflow_state"
  | "cycle"
  | "data_source";

/** How a structure entity relates to another entity or person (the edge the silver graph surfaces). */
export type RelationType =
  | "member" // this entity has a member (a person / a repo in a team)
  | "parent" // this entity's parent container (a page's teamspace, a channel's workspace)
  | "owns" // this entity owns a target (a team owns a repo)
  | "permission" // a repo↔team access grant (the level is in `attrs.permission`)
  | "state_for" // a workflow-state belongs to a team
  | "cycle_for"; // a cycle belongs to a team

/** A scalar attribute value — the only shapes an `attrs` map stores (no nested objects). */
export type AttrValue = string | number | boolean | readonly string[];

/** One typed relation from a structure entity to another entity or a person. */
export interface StructureRelation {
  readonly type: RelationType;
  /** The related entity's source (a source id, or `"person"` when it points at a resolved human). */
  readonly targetSource: string;
  /** The related entity's kind (`team`/`repo`/`person`/…). */
  readonly targetKind: string;
  /** The related entity's native id (its `sourceId`, or a person's `<source>:<nativeId>` key). */
  readonly targetId: string;
  /** Any edge attributes (e.g. `{ permission: "admin" }`). */
  readonly attrs?: Readonly<Record<string, AttrValue>>;
}

/** The curated identity projection of a structure entity — the display fields the directory/graph read. */
export interface StructureIdentityFields {
  readonly nativeId: string;
  readonly name?: string;
  readonly slug?: string;
  readonly url?: string;
}

/** One durable structure row — the identity/attrs/relations projection plus the full raw SDK payload. */
export interface StructureBronzeRow {
  readonly version: 1;
  readonly source: IdentitySource;
  readonly kind: StructureKind;
  /** The source-native id (org login / team id / repo `owner/repo` / channel id / …) — part of the row key. */
  readonly sourceId: string;
  /** When this row was captured (ISO-8601) — EXCLUDED from the dedup fingerprint so a re-hydrate is idempotent. */
  readonly fetchedAtIso: string;
  readonly identity: StructureIdentityFields;
  /** Descriptive attributes (topic/purpose/visibility/archived/language/…) — never a join key. */
  readonly attrs: Readonly<Record<string, AttrValue>>;
  /** The typed edges to other entities/people. Deterministically ordered. */
  readonly relations: readonly StructureRelation[];
  /** How the row was captured + any per-entity notes. Deterministically ordered. */
  readonly provenance: readonly string[];
  /** Non-fatal per-entity warnings (capability/scope gaps) — surfaced, never guessed around. */
  readonly warnings: readonly string[];
  /** The FULL raw entity object (secret-scrubbed string leaves). Nothing projected away. */
  readonly raw: unknown;
}
