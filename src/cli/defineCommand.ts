/**
 * `defineCommand` — the per-verb kit that kills the boilerplate tax of hand-rolled arg parsing, USAGE
 * strings, and inline error tails, and gives every verb a machine-enumerable description of what it
 * DOES. It wraps a verb's run function with typed metadata (`summary`/`usage`/`example`, plus registry
 * hints a `catalog` verb consumes) and returns something the router calls exactly like a bare handler:
 * an `(argv) => Promise<number> | number`. The metadata rides on a frozen `.meta` property, so a
 * defined command is structurally still a `VerbHandler` and drops into `NOUN_GROUPS` with no router
 * change. Auto-discovery (see `discoverCommands`) derives the single command list from the registry +
 * this metadata.
 *
 * Kept tiny + pure: no I/O, no console, no global state — just the wrap.
 */
import type { DoorEffect } from '../admit/types.js'
import { isRecord } from '../lib/parsers.js'
import type { VerbHandler } from './router.js'

/**
 * Typed, machine-enumerable description of a verb. EVERY field is required — a verb spells out its full
 * contract at the call site (no optional flag silently reading as false, masking a side effect or a
 * capability). `example` is `string | null` (null = "no example", stated explicitly).
 */
export interface CommandMeta {
  /** One line: what the verb does. Feeds `catalog` + help. */
  readonly summary: string
  /** Single `usage: slopweaver <noun> <verb> [...]` line. Printed on a parse error. */
  readonly usage: string
  /** A copy-pasteable invocation for help + the catalog, or `null` when there isn't one. */
  readonly example: string | null
  /** Whether running this verb performs a gated/approval-requiring side effect (write, publish). */
  readonly requiresApproval: boolean
  /** Whether running this verb creates a tracked work item. */
  readonly createsWorkItem: boolean
  /**
   * What this verb does to the world (the door's coverage axis). `none`/`external-read` touch nothing
   * persistent; `local-state` writes only under `$SLOPWEAVER_HOME` (the product working normally);
   * `external-write` MUTATES something outside the machine and MUST be `doorRouted`.
   */
  readonly effect: DoorEffect
  /** Whether an `external-write` verb routes its effect through the door (`throughDoor`). Coverage requires it. */
  readonly doorRouted: boolean
  /**
   * Whether invoking this verb with NO args, `--help`, or an unknown flag prints usage / a parse error
   * and returns WITHOUT any side effect (no network, no fs write, no process spawn) — its parse phase is
   * provably separable from its act phase.
   */
  readonly dryParseSafe: boolean
  /**
   * Whether the verb's arg/usage REJECT path (unknown flag, missing value, malformed arg → `EXIT_USAGE`)
   * is provably I/O-free, EVEN THOUGH a valid bare invocation may do I/O. The narrower sibling of
   * {@link dryParseSafe}; a `dryParseSafe` verb already satisfies it.
   */
  readonly parseRejectIsIoFree: boolean
  /**
   * Whether this verb is a DIAGNOSTIC / health-check whose non-zero exit REPORTS A FINDING rather than
   * signalling a broken tool (e.g. `doctor` exits non-zero when the env is unhealthy — it worked
   * perfectly, it found a fault). A THROWN error is still a real bug.
   */
  readonly diagnostic: boolean
}

/** The argv->exit-code run function a verb supplies. Identical contract to a bare `VerbHandler`. */
export type CommandRun = (argv: readonly string[]) => Promise<number> | number

/**
 * A `VerbHandler` that also exposes its `meta`. Callable exactly like a bare handler, so the router
 * (and `NOUN_GROUPS`) treat it identically; the `.meta` is additive for discovery + help.
 */
export type CommandHandler = VerbHandler & { readonly meta: CommandMeta }

export interface DefineCommandInput extends CommandMeta {
  readonly run: CommandRun
}

/**
 * Wrap a verb's `run` with its metadata. Returns a callable handler whose `.meta` is frozen so a
 * discoverer/help renderer can read it without risk of mutation. Behaviour is unchanged: invoking the
 * handler just calls `run(argv)`.
 */
export function defineCommand({ run, ...meta }: DefineCommandInput): CommandHandler {
  const handler: CommandHandler = Object.assign(
    (argv: readonly string[]) => run(argv),
    { meta: Object.freeze(meta) },
  )
  return handler
}

/** Narrow an arbitrary verb handler to one carrying `defineCommand` metadata. */
export function hasCommandMeta(handler: VerbHandler): handler is CommandHandler {
  // A defined command carries a `meta` object; bare `(argv)=>number` handlers do not. Read the property
  // off the function with `in` (no cast), then validate the meta SHAPE so a stray non-meta `meta` can
  // never masquerade as one.
  return 'meta' in handler && isCommandMeta(handler.meta)
}

function isCommandMeta(value: unknown): value is CommandMeta {
  return isRecord(value) && typeof value.summary === 'string' && typeof value.usage === 'string'
}
