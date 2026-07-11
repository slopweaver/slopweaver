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
import { isRecord } from '../lib/parsers.js'
import type { VerbHandler } from './router.js'

/**
 * Typed, machine-enumerable description of a verb. `summary`/`usage`/`example` drive help + the
 * generated catalog; the optional flags are registry hints a planner can read without running the verb.
 */
export interface CommandMeta {
  /** One line: what the verb does. Feeds `catalog` + help. */
  readonly summary: string
  /** Single `usage: slopweaver <noun> <verb> [...]` line. Printed on a parse error. */
  readonly usage: string
  /** Optional copy-pasteable invocation, for help + the catalog. */
  readonly example?: string
  /** True when running this verb performs a gated/approval-requiring side effect (write, publish). */
  readonly requiresApproval?: boolean
  /** True when running this verb creates a tracked work item. */
  readonly createsWorkItem?: boolean
  /**
   * True when invoking this verb with NO args, `--help`, or an unknown flag prints usage / a parse
   * error and returns WITHOUT any side effect (no network, no fs write, no process spawn) — i.e. its
   * parse phase is provably separable from its act phase. Default undefined = treat as unproven.
   */
  readonly dryParseSafe?: boolean
  /**
   * True when the verb's arg/usage REJECT path (unknown flag, missing value, malformed arg →
   * `EXIT_USAGE`) is provably I/O-free, EVEN THOUGH a valid bare invocation may do I/O. The narrower
   * sibling of {@link dryParseSafe}. A `dryParseSafe` verb already satisfies this, so set only ONE.
   */
  readonly parseRejectIsIoFree?: boolean
  /**
   * True when this verb is a DIAGNOSTIC / health-check whose non-zero exit REPORTS A FINDING rather
   * than signalling a broken tool (e.g. `doctor` exits non-zero when the env is unhealthy — it worked
   * perfectly, it found a fault). A THROWN error is still a real bug. Leave undefined for any verb
   * whose non-zero exit means "the tool failed to do its job".
   */
  readonly diagnostic?: boolean
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
