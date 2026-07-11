/**
 * Minimal who-is-who map used by derive to rewrite opaque handles (e.g. a Slack `@U04E9…` id) into a
 * readable `@handle` in opportunity subjects. For GitHub-only v0.1 authors are already human handles, so
 * the map is empty by default and `resolveHandle` is a pass-through — but the seam exists so richer
 * connectors can populate it later.
 *
 * The roster is NEVER committed: an EMPTY `templates/identity.template.json` ships, and a real
 * `identities.json` (if any) is generated into `$SLOPWEAVER_HOME`, off-repo.
 */
import { isRecord } from '../lib/parsers.js'

export interface IdentityRecord {
  readonly id: string
  readonly handle: string
  readonly name: string
}

export type IdentityMap = ReadonlyMap<string, IdentityRecord>

/**
 * Index identity records by `id` (later entries win on duplicate ids).
 *
 * @param records the identity records
 * @returns a map from id to record
 */
export function buildIdentityMap({ records }: { records: readonly IdentityRecord[] }): IdentityMap {
  return new Map(records.map((record) => [record.id, record]))
}

/**
 * Parse a persisted `identities.json` array. Malformed entries are skipped; `handle`/`name` default to
 * `id`/`handle` when absent. Anything unparseable yields an empty list.
 *
 * @param content the raw JSON array text
 * @returns the parsed identity records
 */
export function parseIdentityRecords({ content }: { content: string }): readonly IdentityRecord[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) {
    return []
  }
  const records: IdentityRecord[] = []
  for (const entry of parsed) {
    if (isRecord(entry) && typeof entry.id === 'string' && entry.id.length > 0) {
      const handle = typeof entry.handle === 'string' && entry.handle.length > 0 ? entry.handle : entry.id
      const name = typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : handle
      records.push({ id: entry.id, handle, name })
    }
  }
  return records
}

/**
 * Resolve a raw handle/id to a display `@handle`. A known id maps to `@<handle>`; anything unknown is
 * returned verbatim (never invents a name).
 *
 * @param map the identity map
 * @param raw the raw token (with or without a leading `@`)
 * @returns the resolved `@handle`, or `raw` unchanged when unknown
 */
export function resolveHandle({ map, raw }: { map: IdentityMap; raw: string }): string {
  const bare = raw.startsWith('@') ? raw.slice(1) : raw
  const record = map.get(bare)
  return record !== undefined ? `@${record.handle}` : raw
}
