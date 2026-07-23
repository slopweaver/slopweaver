/**
 * Project hydrated member rows into the resolver's {@link PersonIdentity} candidates — the feed that lets
 * the PR4 resolver's already-built `email` tier auto-link the whole team cross-source. Data-first (D8):
 * a candidate carries an `email` ONLY when the row's email is `trusted` (a weak/held email is dropped from
 * the join surface, never merged), and a bot / deactivated member is excluded from the join entirely (it
 * still lives in member bronze + the dossier, just never auto-links). Pure — no I/O.
 */
import type { PersonIdentity } from "../../silver/identity.js";
import { trustedJoinEmail } from "./email.js";
import type { MemberBronzeRow } from "./types.js";

/** Whether a member may participate in cross-source auto-linking: a real, active human (not a bot). Pure. */
export function isLinkableMember({ row }: { row: MemberBronzeRow }): boolean {
  return row.profile.bot !== true && row.profile.active !== false;
}

/**
 * One member row → a resolver {@link PersonIdentity} candidate. Data-first (D8): the ONLY merge key a
 * member contributes is a TRUSTED `email` — a weak/missing email yields a candidate with NO email, AND
 * with NO `handle` either, so it can never merge (the resolver's handle tier would otherwise cross-link two
 * unrelated people who happen to share a handle across sources — the exact fuzzy match the spec forbids).
 * The `handle` rides along only when a trusted email is present (email wins in `classifyFree`, so the handle
 * is display-only there); `name` is always kept — it only ever produces a HELD name candidate, never a merge.
 * Pure.
 *
 * @param row the member row
 * @returns the candidate identity
 */
export function memberCandidate({ row }: { row: MemberBronzeRow }): PersonIdentity {
  const email = trustedJoinEmail({ row });
  const { handle, name } = row.identity;
  const carryHandle = email !== undefined && handle !== undefined;
  return {
    nativeId: row.identity.nativeId,
    source: row.source,
    ...(carryHandle ? { handle } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(email !== undefined ? { email } : {}),
  };
}

/**
 * The resolver candidates for a set of member rows — one per LINKABLE member (bots + deactivated members
 * excluded from the join). Deterministic order (input order). Pure.
 *
 * @param rows the hydrated member rows
 * @returns the per-source identity candidates to feed `resolveFromRecords`/`resolvePeople`
 */
export function memberIdentityCandidates({ rows }: { rows: readonly MemberBronzeRow[] }): readonly PersonIdentity[] {
  return rows.filter((row) => isLinkableMember({ row })).map((row) => memberCandidate({ row }));
}

/** The distinct per-member warnings across a source's rows (deduped, sorted) — for the refresh summary. Pure. */
export function aggregateMemberWarnings({ rows }: { rows: readonly MemberBronzeRow[] }): readonly string[] {
  return [...new Set(rows.flatMap((row) => row.warnings))].toSorted();
}
