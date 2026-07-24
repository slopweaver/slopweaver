/**
 * The answer-time access gate (PR4.5): given who is ASKING versus who OWNS this world model, withhold the
 * private lane from anyone but the owner. Slopweaver is single-user today — the CLI runs as the owner, so
 * `trustedOwnerCli` is the normal path — but the gate + the per-record stamp are built now so sharing the
 * plugin later (a teammate installs it and queries YOUR corpus) is safe by construction: default-deny,
 * with `public` (and any unmarked legacy record) visible to everyone.
 *
 * DECISION (2026-07-25, Lachie) — THE OWNER SEES EVERY LANE, FOR EVERY ASK. In single-user dogfooding a
 * DM / private-channel discussion is useful org context, not something to hide from yourself, so an
 * ordinary org ask ("what's the latest on pricing") searches the private lane too. The private/public
 * split therefore gates ONLY a non-owner (the future shared-corpus case) — never the owner's own asks.
 * The first-person owner LENS (handle injection + recency relax, see {@link ./ownerScope.planOwnerRetrieval})
 * is orthogonal: it re-ranks for "my ..." asks but never changes WHICH lanes the owner may see.
 * TO REVERT (if we ever want a "clean org overview" that excludes the owner's private lane on non-first
 * -person asks): in {@link planOwnerScopedRetrieval}, when `askerIsOwner` and NOT `plan.ownerScoped`,
 * `.filter(r => visibilityForRecord({ record: r }) === "public")` the scoped records before returning.
 *
 * Pure, no I/O. This is the leak-safety boundary: a non-owner NEVER receives a `private` record.
 */
import type { CorpusRecord } from "../corpus/types.js";
import { visibilityForRecord } from "../corpus/visibility.js";
import { type OwnerIdentity, planOwnerRetrieval } from "./ownerScope.js";
import type { DecayParams } from "./recencyDecay.js";

/**
 * Who is asking, and who owns the corpus. `trustedOwnerCli` is the single-user path — the owner running
 * their own CLI is the owner by construction. A remote/asserted asker is the owner ONLY when both ids are
 * known and equal (fail-closed: an unknown asker is treated as a non-owner).
 */
export interface AskScope {
  readonly askerPersonId?: string;
  readonly ownerPersonId?: string;
  readonly trustedOwnerCli: boolean;
}

/**
 * Whether the asker is the owner: the trusted local CLI, or a known asker id equal to a known owner id.
 * Fail-closed — any missing id makes a non-CLI asker a non-owner.
 *
 * @param scope the ask scope
 * @returns true iff the asker is the owner
 */
export function askerIsOwner({ scope }: { scope: AskScope }): boolean {
  if (scope.trustedOwnerCli) {
    return true;
  }
  return (
    scope.askerPersonId !== undefined &&
    scope.ownerPersonId !== undefined &&
    scope.askerPersonId === scope.ownerPersonId
  );
}

/**
 * Scope a record set to what the asker may read: the owner sees every record; a non-owner sees only
 * `public` records (every `private` record is withheld). Unmarked legacy records read as `public`, so
 * they are always visible. Pure — order-preserving, never mutates the input.
 *
 * @param records the full record set
 * @param scope the ask scope (asker vs owner)
 * @returns the records the asker is allowed to see
 */
export function scopeRecordsForAsker({
  records,
  scope,
}: {
  records: readonly CorpusRecord[];
  scope: AskScope;
}): readonly CorpusRecord[] {
  if (askerIsOwner({ scope })) {
    return records;
  }
  return records.filter((record) => visibilityForRecord({ record }) === "public");
}

/**
 * The complete owner-lens plan for a single-user CLI ask (PR4.5): the CLI runs AS the owner
 * (`trustedOwnerCli`), so this composes the first-person lens ({@link planOwnerRetrieval}) with the record
 * scope ({@link scopeRecordsForAsker}) into the record set to search + the retrieval query + the (possibly
 * relaxed) decay. Pure — both query verbs use it, so the "asker is the owner" assumption lives in one
 * place. Per the module DECISION, the OWNER's record set is every lane (`scopeRecordsForAsker` returns all
 * to the owner) regardless of whether the lens engaged; the lens only rewrites the QUERY. A non-owner is
 * scoped to public by the same call. So an org ask is additive — same lanes as before the visibility axis.
 *
 * @param question the original question
 * @param records the full loaded corpus
 * @param owner the resolved owner identity, when set
 * @param decay the base recency-decay params, when set
 * @returns the records to search, the retrieval query, and the decay to rank with
 */
export function planOwnerScopedRetrieval({
  question,
  records,
  owner,
  decay,
}: {
  question: string;
  records: readonly CorpusRecord[];
  owner: OwnerIdentity | undefined;
  decay: DecayParams | undefined;
}): { records: readonly CorpusRecord[]; query: string; decay?: DecayParams } {
  const plan = planOwnerRetrieval({ decay, owner, question });
  const scope: AskScope = {
    trustedOwnerCli: true,
    ...(owner !== undefined ? { askerPersonId: owner.personId, ownerPersonId: owner.personId } : {}),
  };
  const selected = scopeRecordsForAsker({ records, scope });
  return { query: plan.query, records: selected, ...(plan.decay !== undefined ? { decay: plan.decay } : {}) };
}
