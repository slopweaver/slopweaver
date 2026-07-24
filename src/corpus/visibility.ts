/**
 * The per-record visibility axis (PR4.5) — the leak-safety choke-point. This module is the SINGLE
 * producer of a `private` stamp: `stampVisibility` is the only function anywhere that returns a record
 * carrying `visibility: "private"`. Every private-lane record (Slack private channels / DMs / mpim) is
 * routed through it at projection time, where the private signal is known — so nothing reaches disk
 * unstamped. `visibilityForRecord` is the mirror reader: it defaults an absent/unknown mark to `public`,
 * which is the migration contract (a record written before this field reads back as public).
 *
 * Pure, no I/O. A public stamp is a pass-through (the field stays absent), so a public record serialises
 * byte-identically to pre-PR4.5 bronze and never churns the dedup fingerprint.
 */
import type { CorpusRecord, CorpusVisibility } from "./types.js";

/**
 * Stamp a record's read scope — the ONLY producer of a `private` mark. A `private` visibility sets the
 * field; a `public` visibility returns the record unchanged (the field stays absent, i.e. the default),
 * so public records stay byte-identical to legacy bronze.
 *
 * @param record the projected record
 * @param visibility the lane it was projected from (`private` for Slack private channels / DMs / mpim)
 * @returns the record with a `private` stamp when private, else the record unchanged
 */
export function stampVisibility({
  record,
  visibility,
}: {
  record: CorpusRecord;
  visibility: CorpusVisibility;
}): CorpusRecord {
  return visibility === "private" ? { ...record, visibility: "private" } : record;
}

/**
 * A record's effective read scope. Only an explicit `"private"` is restrictive; an absent or unrecognised
 * mark reads as `public` (the default-public migration contract), so a legacy record is never fail-closed.
 *
 * @param record the record to classify
 * @returns `"private"` iff the record is explicitly private, else `"public"`
 */
export function visibilityForRecord({ record }: { record: CorpusRecord }): CorpusVisibility {
  return record.visibility === "private" ? "private" : "public";
}
