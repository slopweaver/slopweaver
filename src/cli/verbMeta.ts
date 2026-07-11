/**
 * Resolve a verb's declared metadata from the live noun registry WITHOUT loading its module.
 *
 * A manifest verb carries its `CommandMeta` on the registry entry (see manifest.ts), so a caller can
 * ask "is this verb's parse phase provably I/O-free?" (`dryParseSafe`) or "is this a diagnostic?"
 * without importing the command. Pure: reads the registry, no I/O.
 */
import { isManifestEntry } from './manifest.js'
import { NOUN_GROUPS } from './nounGroups.js'

/**
 * Whether `<noun> <verb>` is a manifest verb whose `CommandMeta` declares `dryParseSafe: true` — i.e.
 * its no-arg / `--help` / bad-flag path prints usage and returns with zero I/O. Unknown noun/verb or a
 * legacy handler -> false.
 */
export function isDryParseSafe(noun: string, verb: string): boolean {
  const entry = NOUN_GROUPS[noun]?.[verb]
  return entry !== undefined && isManifestEntry(entry) && entry.meta.dryParseSafe === true
}

/**
 * Whether `<noun> <verb>` declares its arg/usage-reject path is I/O-free — either via `dryParseSafe`
 * (which also asserts the bare invocation is probe-safe) OR the narrower `parseRejectIsIoFree`. Unknown
 * / legacy -> false.
 */
export function isParseRejectIoFree(noun: string, verb: string): boolean {
  const entry = NOUN_GROUPS[noun]?.[verb]
  if (entry === undefined || !isManifestEntry(entry)) {
    return false
  }
  return entry.meta.dryParseSafe === true || entry.meta.parseRejectIsIoFree === true
}

/**
 * Whether `<noun> <verb>` is a manifest verb whose `CommandMeta` declares `diagnostic: true` — a
 * health-check whose non-zero exit REPORTS A FINDING rather than signalling a broken tool. Unknown
 * noun/verb or a legacy handler -> false.
 */
export function isDiagnosticVerb(noun: string, verb: string): boolean {
  const entry = NOUN_GROUPS[noun]?.[verb]
  return entry !== undefined && isManifestEntry(entry) && entry.meta.diagnostic === true
}
