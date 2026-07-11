/**
 * "Usage invocation" classification — a run where NO verb/command was ever dispatched: the CLI only
 * printed usage or help and exited non-zero. The shapes are a bare noun with no resolvable verb
 * (`slopweaver doctor` with an unknown verb), a flag in the command slot (`slopweaver --help`), and an
 * unknown command.
 *
 * v0.1 is noun/verb only — there are no flat (verb-less) subcommands yet, so `FLAT_SUBCOMMANDS` is
 * empty. The list stays here as the single source of truth for that surface as it grows. Pure: reads the
 * live noun registry, no I/O.
 */
import { NOUN_GROUPS } from './nounGroups.js'
import { resolveNoun } from './router.js'

/**
 * The flat subcommands (no noun/verb). Empty in v0.1; append here when a verb-less top-level command is
 * introduced, and the usage predicate below reads it to tell a real flat command from an unknown one.
 */
export const FLAT_SUBCOMMANDS = [] as const

export type FlatSubcommand = (typeof FLAT_SUBCOMMANDS)[number]

/** Whether argv[2] names a supported flat subcommand. */
export function isFlatSubcommand(value: string | undefined): value is FlatSubcommand {
  return value !== undefined && (FLAT_SUBCOMMANDS as readonly string[]).includes(value)
}

/**
 * True when `argv` (full process argv) would dispatch NO handler — the CLI only renders usage/help. That
 * is the case when argv[2] resolves to no noun route (respecting the default-verb convention) AND is not
 * a flat subcommand. Pure: reads the live noun registry, no I/O.
 */
export function isUsageInvocation(argv: readonly string[]): boolean {
  return resolveNoun(NOUN_GROUPS, argv) === null && !isFlatSubcommand(argv[2])
}
