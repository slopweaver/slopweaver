/**
 * The effectful edge that resolves the OWNER's cross-source identity for the query shells (`ask`/`facts`).
 * It reads the persona seed (`profile.json`), the identity roster, and the hydrated members, then folds
 * them (+ the already-loaded corpus records) through the PR4 resolver — exactly the wiring the `identity`
 * verb uses — and hands back the owner's {@link OwnerIdentity} (or `undefined` when no owner is set, so
 * the owner lens stays off and retrieval is an ordinary org ask).
 *
 * A thin shell over pure cores: {@link resolveFromRecords} + {@link ownerIdentityFromResolution}. Isolated
 * here so both query verbs share one implementation and one injectable seam.
 */
import { memberIdentityCandidates } from "../../../corpus/members/project.js";
import { readAllMembers } from "../../../corpus/members/store.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { loadProfile } from "../../../profileStore.js";
import { ownerIdentityFromResolution } from "../../../retrieval/ownerIdentity.js";
import type { OwnerIdentity } from "../../../retrieval/ownerScope.js";
import { loadIdentityRoster } from "../../../silver/loadIdentityRoster.js";
import { resolveFromRecords } from "../../../silver/personResolver.js";

/**
 * Resolve the owner identity from `$SLOPWEAVER_HOME` + the loaded corpus. Returns `{ owner: undefined }`
 * when there is no persona seed (⇒ no owner ⇒ the lens is off).
 *
 * @param home the world-model home
 * @param records the already-loaded corpus records (fed to the resolver alongside the roster + members)
 * @returns the resolved owner identity, or `{ owner: undefined }`
 */
export function loadOwnerContext({ home, records }: { home: string; records: readonly CorpusRecord[] }): {
  owner: OwnerIdentity | undefined;
} {
  const profile = loadProfile({ home });
  if (profile === undefined) {
    return { owner: undefined };
  }
  const members = readAllMembers({ home });
  const resolution = resolveFromRecords({
    extraCandidates: memberIdentityCandidates({ rows: members.rows }),
    records,
    roster: loadIdentityRoster({ home }),
  });
  return { owner: ownerIdentityFromResolution({ profile, resolution }) };
}
