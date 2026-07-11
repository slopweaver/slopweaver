/**
 * Nested `slopweaver <noun> <verb>` routing.
 *
 * Every command is a noun group (`<noun> <verb>`, e.g. `doctor run`): a standalone utility that parses
 * its own argv tail and returns a process exit code. Nouns register in the manifest barrel; the router
 * resolves argv against the registry.
 */
import { isManifestEntry, type VerbManifestEntry } from './manifest.js'

/** A verb handler parses its own argv tail and returns a process exit code. */
export type VerbHandler = (argv: readonly string[]) => Promise<number> | number

/**
 * A registry value is either a legacy `VerbHandler` (called directly) or a lazy `VerbManifestEntry`
 * (metadata up-front, run function fetched on dispatch). Both route + enumerate identically. See
 * `manifest.ts`.
 */
export type RegistryEntry = VerbHandler | VerbManifestEntry

export type NounGroups = Readonly<Record<string, Readonly<Record<string, RegistryEntry>>>>

/**
 * A resolved route. Discriminated on `kind`: a `legacy` route carries the handler to call directly; a
 * `manifest` route carries the lazy entry whose `load()` the dispatcher awaits before running. Keeping
 * them distinct means enumeration can read a manifest verb's meta without importing its module, and
 * only the dispatcher pays the import.
 */
export type NounRoute =
  | { readonly kind: 'legacy'; readonly noun: string; readonly verb: string; readonly handler: VerbHandler }
  | { readonly kind: 'manifest'; readonly noun: string; readonly verb: string; readonly entry: VerbManifestEntry }

function routeFor({ noun, verb, entry }: { noun: string; verb: string; entry: RegistryEntry }): NounRoute {
  return isManifestEntry(entry)
    ? { kind: 'manifest', noun, verb, entry }
    : { kind: 'legacy', noun, verb, handler: entry }
}

/**
 * Resolve `argv` (full process argv: [node, cli, noun, verb, ...]) against the registry. Returns the
 * matching route, or null when argv[2] is not a registered noun OR the verb is missing/unknown — so the
 * caller can render usage (see isNoun).
 */
export function resolveNoun(groups: NounGroups, argv: readonly string[]): NounRoute | null {
  const noun = argv[2]
  if (noun === undefined) {
    return null
  }
  const verbs = groups[noun]
  if (verbs === undefined) {
    return null
  }
  const verb = argv[3]
  // Default-verb convention: a noun may register a `''` handler as its default, so a verb-less
  // invocation runs it — e.g. bare `slopweaver doctor` -> `doctor run`, or a bare noun where the tail is
  // FLAGS for the default verb, not a verb word. Both shapes mean "no verb given": argv[3] is either
  // undefined or starts with `--`. Nouns without a `''` default fall through to usage (isNoun renders).
  if (verb === undefined || verb.startsWith('--')) {
    const fallback = verbs['']
    return fallback === undefined ? null : routeFor({ noun, verb: '', entry: fallback })
  }
  const entry = verbs[verb]
  if (entry === undefined) {
    return null
  }
  return routeFor({ noun, verb, entry })
}

/** Whether argv[2] names a registered noun group (even if the verb is missing/unknown). */
export function isNoun(groups: NounGroups, argv: readonly string[]): boolean {
  const noun = argv[2]
  return noun !== undefined && noun in groups
}

/**
 * Render usage for the noun groups: a `slopweaver <noun> <verbs>` line each, with a one-line summary
 * beneath when supplied. Pass `only` to scope the listing to a single noun (so `slopweaver <noun>` with
 * no verb shows just that noun's verbs, not the whole surface).
 */
export function renderNounUsage(
  groups: NounGroups,
  summaries: Readonly<Record<string, string>> = {},
  only?: string,
): string {
  const nouns = (only !== undefined && only in groups ? [only] : Object.keys(groups)).sort()
  return nouns
    .map((noun) => {
      // Skip the `''` default-verb alias (it points at a real named verb; listing it shows a blank).
      const verbs = Object.keys(groups[noun] ?? {}).filter((v) => v !== '').sort().join(' | ')
      const head = `  slopweaver ${noun} <${verbs}>`
      const summary = summaries[noun]
      return summary === undefined ? head : `${head}\n      ${summary}`
    })
    .join('\n')
}
