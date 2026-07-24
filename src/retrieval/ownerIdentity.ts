/**
 * Resolve the OWNER's cross-source identity (PR4.5) from the persona seed + the PR4 identity map. The
 * owner is named by `profile.json`'s `id`; we find the canonical person carrying that id and gather the
 * handles that name them across GitHub / Slack / Linear / Notion (native ids, handles, display names),
 * seeded with the profile's own `displayName`/`gitNamespace`. Those handles are what the owner lens
 * injects into a first-person retrieval query.
 *
 * Pure, no I/O — the caller injects the already-read profile + resolution. Returns `undefined` when there
 * is no owner id and nothing to inject, so the lens simply stays off (an ordinary org ask).
 */

import type { Profile } from "../profile.js";
import type { IdentityResolution, Person } from "../silver/identity.js";
import type { OwnerIdentity } from "./ownerScope.js";

/** The distinct, non-empty handles a person is named by across sources: native ids, handles, names. Pure. */
function personHandles({ person }: { person: Person }): readonly string[] {
  return person.identities.flatMap((identity) => [
    identity.nativeId,
    ...(identity.handle !== undefined ? [identity.handle] : []),
    ...(identity.name !== undefined ? [identity.name] : []),
  ]);
}

/** Dedup, dropping empty/blank strings, preserving first-seen order. Pure. */
function dedupeNonEmpty({ values }: { values: readonly string[] }): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const trimmed = value.trim();
    if (trimmed.length > 0 && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

/**
 * Build the owner's {@link OwnerIdentity} from the profile seed + the identity resolution. The person id
 * is `profile.id`; handles are the profile's `displayName`/`gitNamespace` plus every handle of the
 * canonical person with that id (when present in the map). `undefined` when there is no owner id at all.
 *
 * @param profile the persona seed (`profile.json`)
 * @param resolution the PR4 cross-source identity resolution
 * @returns the owner's cross-source identity, or `undefined` when no owner id is set
 */
export function ownerIdentityFromResolution({
  profile,
  resolution,
}: {
  profile: Profile;
  resolution: IdentityResolution;
}): OwnerIdentity | undefined {
  if (profile.id.trim().length === 0) {
    return undefined;
  }
  const person = resolution.people.find((candidate) => candidate.id === profile.id);
  const handles = dedupeNonEmpty({
    values: [profile.displayName, profile.gitNamespace, ...(person !== undefined ? personHandles({ person }) : [])],
  });
  return { handles, personId: profile.id };
}
