/**
 * Pure presentation for the `identity` verb — render a resolution / a single person as terminal lines or
 * as a JSON-serialisable value. No I/O: the shell ({@link ./run}) injects the corpus + roster reads; this
 * module only shapes what they resolved to. Kept pure so it's unit-tested with exact assertions.
 */
import type { IdentityResolution, Person, PersonIdentity } from "../../../silver/identity.js";

/** One identity as a compact line: `github:ada @ada <ada@x>`. */
function identityLine({ identity }: { identity: PersonIdentity }): string {
  const parts = [`${identity.source}:${identity.nativeId}`];
  if (identity.handle !== undefined) {
    parts.push(`@${identity.handle}`);
  }
  if (identity.email !== undefined) {
    parts.push(`<${identity.email}>`);
  }
  return `  ${parts.join(" ")}`;
}

/**
 * Render one person as a block: a header (id · confidence · display name), one line per source identity,
 * and the provenance. Pure.
 *
 * @param person the canonical person
 * @returns the block's lines
 */
export function renderPersonBlock({ person }: { person: Person }): readonly string[] {
  return [
    `${person.id}  [${person.confidence}]  ${person.displayName}`,
    ...person.identities.map((identity) => identityLine({ identity })),
    `  linked-by: ${person.provenance.join(", ")}`,
  ];
}

/**
 * Render the whole resolution: every person block, then any HELD name candidates. A resolution with no
 * people renders one guidance line. Pure.
 *
 * @param resolution the identity resolution
 * @returns the terminal lines
 */
export function renderPeople({ resolution }: { resolution: IdentityResolution }): readonly string[] {
  if (resolution.people.length === 0) {
    return ["(no identities — seed $SLOPWEAVER_HOME/identity.json or run `slopweaver refresh` first)"];
  }
  const blocks = resolution.people.flatMap((person) => [...renderPersonBlock({ person }), ""]);
  const held = resolution.candidates.map(
    (candidate) => `held name-link: ${candidate.personIds.join(" ~ ")} (${candidate.reason})`,
  );
  return [...blocks, ...held];
}

/** A person as a JSON-serialisable value (stable key order via the interface). Pure. */
export function personToJson({ person }: { person: Person }): unknown {
  return {
    confidence: person.confidence,
    displayName: person.displayName,
    id: person.id,
    identities: person.identities,
    provenance: person.provenance,
  };
}

/** The whole resolution as a JSON-serialisable value (people + held candidates + conflicts). Pure. */
export function peopleToJson({ resolution }: { resolution: IdentityResolution }): unknown {
  return {
    candidates: resolution.candidates,
    conflicts: resolution.conflicts,
    people: resolution.people.map((person) => personToJson({ person })),
  };
}
