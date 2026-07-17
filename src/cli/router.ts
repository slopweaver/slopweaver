/**
 * Nested `slopweaver <noun> <verb>` routing.
 *
 * Every command is a noun group (`<noun> <verb>`, e.g. `doctor run`): a standalone utility that parses
 * its own argv tail and returns a process exit code. Nouns register in the manifest barrel; the router
 * resolves argv against the registry.
 */
import { DEFAULT_VERB, isManifestEntry, type VerbManifestEntry } from './manifest.js'

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
 * Resolve `argv` (full process argv: [node, cli, noun, verb, ...]) against the registry.
 *
 * @param groups the noun registry
 * @param argv the full process argv
 * @returns the matching route, or null when argv[2] is not a registered noun OR the verb is
 *   missing/unknown — so the caller can render usage (see isNoun)
 */
export function resolveNoun({ groups, argv }: { groups: NounGroups; argv: readonly string[] }): NounRoute | null {
  const noun = argv[2]
  if (noun === undefined) {
    return null
  }
  const verbs = groups[noun]
  if (verbs === undefined) {
    return null
  }
  const verb = argv[3]
  // A registered verb wins outright (e.g. `doctor run`).
  const entry = verb !== undefined ? verbs[verb] : undefined
  if (entry !== undefined) {
    return routeFor({ noun, verb, entry })
  }
  // Default-verb convention: a noun may register a {@link DEFAULT_VERB} handler as its default. It runs
  // whenever there is no verb given (argv[3] undefined or a `--flag`) AND when argv[3] is a non-verb token
  // — i.e. an ARGUMENT for the default verb, not a verb word. This is what lets `slopweaver ask <free text>`
  // and `slopweaver doctor` both work: the default handler owns the whole tail. Nouns without a default
  // fall through to usage (isNoun renders) for any unknown verb.
  const fallback = verbs[DEFAULT_VERB]
  return fallback === undefined ? null : routeFor({ noun, verb: DEFAULT_VERB, entry: fallback })
}

/**
 * Whether argv[2] names a registered noun group (even if the verb is missing/unknown).
 *
 * @param groups the noun registry
 * @param argv the full process argv
 * @returns true when argv[2] is a registered noun
 */
export function isNoun({ groups, argv }: { groups: NounGroups; argv: readonly string[] }): boolean {
  const noun = argv[2]
  return noun !== undefined && noun in groups
}

/**
 * Render usage for the noun groups: a `slopweaver <noun> <verbs>` line each, with a one-line summary
 * beneath when supplied.
 *
 * @param groups the noun registry
 * @param summaries the per-noun one-line summaries (default none)
 * @param only scope the listing to a single noun (so `slopweaver <noun>` with no verb shows just that
 *   noun's verbs, not the whole surface)
 * @returns the rendered usage block
 */
export function renderNounUsage(
  { groups, summaries = {}, only }:
  { groups: NounGroups; summaries?: Readonly<Record<string, string>>; only?: string },
): string {
  const nouns = (only !== undefined && only in groups ? [only] : Object.keys(groups)).sort()
  return nouns
    .map((noun) => {
      // Skip the DEFAULT_VERB alias (it points at a real named verb; listing it shows a blank).
      const verbs = Object.keys(groups[noun] ?? {}).filter((v) => v !== DEFAULT_VERB).sort().join(' | ')
      const head = `  slopweaver ${noun} <${verbs}>`
      const summary = summaries[noun]
      return summary === undefined ? head : `${head}\n      ${summary}`
    })
    .join('\n')
}
