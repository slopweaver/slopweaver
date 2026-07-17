/**
 * The persona/profile seed persisted at `$SLOPWEAVER_HOME/profile.json`. Deliberately THIN and generic
 * for now (D3: built for me, dogfooded — not a generalised multi-user config): who the agent acts as,
 * the git namespace its PRs come from, and which sources it draws on. Later PRs (voice/persona, PR13)
 * grow it; PR1 only reserves the shape + a strict parser so a hand-edited file fails loudly, not silently.
 *
 * Pure: `parseProfile` narrows an already-parsed JSON value — no I/O. The file is seeded from
 * `templates/profile.template.json` by `stateInit` and never overwritten.
 */
import { err, ok, type Result } from './lib/result.js'
import { isRecord } from './lib/parsers.js'

/** The profile schema version; bump with a migration. A file at a different version is rejected, not coerced. */
export const PROFILE_SCHEMA_VERSION = 1

/** The persona/profile seed. Fields are generic; empty strings are the un-set default. */
export interface Profile {
  /** Schema version — must equal {@link PROFILE_SCHEMA_VERSION}. */
  readonly schemaVersion: number
  /** A stable local id for the persona the agent acts as (default `"me"`). */
  readonly id: string
  /** Human display name for the persona (empty until set). */
  readonly displayName: string
  /** The git author/namespace PRs and commits are attributed to (empty until set). */
  readonly gitNamespace: string
  /** The corpus sources this profile draws on (e.g. `github`); empty until set. */
  readonly sources: readonly string[]
}

/**
 * Parse + validate an already-decoded JSON value into a {@link Profile}. Strict: a non-object, a wrong
 * `schemaVersion`, or a mistyped field is an error (so a corrupt hand-edit surfaces at read time).
 * Unknown extra fields are ignored — only the known fields are read.
 *
 * @param value a parsed JSON value (e.g. from `readJsonFile`)
 * @returns the validated profile, or an error listing every violation
 */
export function parseProfile({ value }: { value: unknown }): Result<Profile> {
  if (!isRecord(value)) {
    return err(['profile.json is not a JSON object'])
  }
  const errors: string[] = []
  const { schemaVersion, id, displayName, gitNamespace, sources } = value
  if (schemaVersion !== PROFILE_SCHEMA_VERSION) {
    errors.push(`profile.json schemaVersion must be ${String(PROFILE_SCHEMA_VERSION)}, got ${JSON.stringify(schemaVersion)}`)
  }
  if (typeof id !== 'string') {
    errors.push('profile.json id must be a string')
  }
  if (typeof displayName !== 'string') {
    errors.push('profile.json displayName must be a string')
  }
  if (typeof gitNamespace !== 'string') {
    errors.push('profile.json gitNamespace must be a string')
  }
  if (!(Array.isArray(sources) && sources.every((s): s is string => typeof s === 'string'))) {
    errors.push('profile.json sources must be an array of strings')
  }
  if (errors.length > 0) {
    return err(errors)
  }
  // The guards above all held; re-narrow (no casts) so the constructor sees the concrete types.
  if (typeof id === 'string' && typeof displayName === 'string' && typeof gitNamespace === 'string' && Array.isArray(sources)) {
    return ok({
      schemaVersion: PROFILE_SCHEMA_VERSION,
      id,
      displayName,
      gitNamespace,
      sources: sources.filter((s): s is string => typeof s === 'string'),
    })
  }
  return err(['profile.json failed validation'])
}
