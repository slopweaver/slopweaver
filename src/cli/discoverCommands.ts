/**
 * Registry auto-discovery — the single source a `catalog` verb and a help renderer both derive from.
 *
 * Walks the `NOUN_GROUPS` registry into one flat list of `{ noun, verb, meta? }`. Deriving from
 * `NOUN_GROUPS` — rather than a second hand-maintained list — means a verb cannot be described without
 * being wired, and cannot be wired without appearing in the catalog.
 *
 * Pure: no I/O. Caller passes the registry (`NOUN_GROUPS`) so this stays trivially testable.
 */
import { type CommandMeta, hasCommandMeta } from "./defineCommand.js";
import { DEFAULT_VERB, isManifestEntry } from "./manifest.js";
import type { NounGroups } from "./router.js";

export interface DiscoveredCommand {
  readonly noun: string;
  readonly verb: string;
  /** The verb's metadata, or `null` for a bare handler (stated explicitly, not an absent field). */
  readonly meta: CommandMeta | null;
}

/** A discovered command that is known to carry metadata (a documented verb). */
export type DocumentedCommand = DiscoveredCommand & { readonly meta: CommandMeta };

/**
 * Enumerate every registered noun/verb in the registry, attaching metadata where present. Sorted by
 * noun then verb for stable catalog/help output.
 *
 * @param groups the noun registry
 * @returns the flat, sorted list of discovered commands
 */
export function discoverCommands({ groups }: { groups: NounGroups }): readonly DiscoveredCommand[] {
  const commands: DiscoveredCommand[] = [];
  for (const noun of Object.keys(groups)) {
    const verbs = groups[noun] ?? {};
    for (const verb of Object.keys(verbs)) {
      const entry = verbs[verb];
      // The DEFAULT_VERB key is an alias for a real named verb (e.g. doctor default -> run); skip it so
      // the catalog enumerates each command once, not a phantom blank-verb entry.
      if (entry === undefined || verb === DEFAULT_VERB) {
        continue;
      }
      // A lazy manifest entry exposes its meta WITHOUT importing the command module — enumeration of a
      // noun pays zero import cost.
      if (isManifestEntry(entry)) {
        commands.push({ meta: entry.meta, noun, verb });
        continue;
      }
      commands.push(hasCommandMeta(entry) ? { meta: entry.meta, noun, verb } : { meta: null, noun, verb });
    }
  }
  return commands.toSorted((a, b) => (a.noun === b.noun ? a.verb.localeCompare(b.verb) : a.noun.localeCompare(b.noun)));
}
