/**
 * The member-bronze contract — one durable, source-agnostic person row per member of an org, captured by
 * the hydration pass (Slack/Linear/Notion/GitHub) and persisted under `$SLOPWEAVER_HOME/corpus/members/`.
 *
 * Unlike a {@link CorpusRecord} (activity), a member row is IDENTITY substrate: it carries the person's
 * native id + email + rich profile + the FULL raw SDK payload (nothing projected away, mirroring record
 * bronze's raw-retention), and it deliberately never enters the record reader / retrieval / embeddings.
 * The typed `identity`/`profile` are the curated projection; `raw` is the loss-free capture.
 */
import type { IdentitySource } from "../../silver/identity.js";

/**
 * How much a captured email can be trusted as a cross-source JOIN key: `trusted` (a real, unique personal
 * email — the resolver may auto-link on it), `weak` (a `noreply`/role/shared alias, or one seen on more
 * than one member of the same source — HELD, never merged), `missing` (no email — a capability/scope gap).
 */
export type EmailTrust = "trusted" | "weak" | "missing";

/** The curated identity projection of a member — the join fields the resolver reads. */
export interface MemberIdentityFields {
  readonly source: IdentitySource;
  readonly nativeId: string;
  readonly handle?: string;
  readonly name?: string;
  /** The captured email verbatim (any trust). Present even when `weak` so the dossier can surface it. */
  readonly email?: string;
  /** The normalised (lower/trim) email — the actual join key. Present only when an email was captured. */
  readonly emailNormalised?: string;
  readonly emailTrust: EmailTrust;
}

/** The rich profile projection — descriptive attrs the dossier aggregates (never a join key). */
export interface MemberProfileFields {
  readonly title?: string;
  readonly timezone?: string;
  readonly avatarUrl?: string;
  readonly teams?: readonly string[];
  readonly active?: boolean;
  readonly admin?: boolean;
  readonly guest?: boolean;
  readonly bot?: boolean;
}

/** One durable member row — the identity/profile projection plus the full raw SDK payload + provenance. */
export interface MemberBronzeRow {
  readonly version: 1;
  readonly source: IdentitySource;
  /** The source-native id (Slack user id / Linear user id / Notion user id / GitHub login) — the row key. */
  readonly sourceId: string;
  /** When this row was captured (ISO-8601) — EXCLUDED from the dedup fingerprint so a re-hydrate is idempotent. */
  readonly fetchedAtIso: string;
  readonly identity: MemberIdentityFields;
  readonly profile: MemberProfileFields;
  /** How the row was captured + any per-member notes (e.g. `email-scope-missing`). Deterministically ordered. */
  readonly provenance: readonly string[];
  /** Non-fatal per-member warnings (capability/scope gaps) — surfaced, never guessed around. */
  readonly warnings: readonly string[];
  /** The FULL raw member object (secret-scrubbed string leaves, email PRESERVED). Nothing projected away. */
  readonly raw: unknown;
}
