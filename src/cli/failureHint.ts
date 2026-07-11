/**
 * failureHint — map a FAILED run to a ONE-LINE "likely cause + next step", printed inline to stderr the
 * instant a verb fails, so the operator sees it immediately instead of staring at a bare non-zero exit.
 *
 * The mapper is PURE: a lookup over the failure facts the dispatch edge already has (noun / verb / code
 * / error_class / reason). No fs, no clock. An UNKNOWN failure returns null — stay quiet, never guess (a
 * wrong hint is worse than none). {@link surfaceFailureHint} is the thin IO edge the CLI wires in.
 *
 * Signature discipline: each entry matches a GENERAL signature class (a lock/contention family, an API
 * `*_not_found`, a missing auth token), NOT one literal message — so it survives wording drift. Keep the
 * list small with each `why` inline. When in doubt, add NO entry.
 */

import { errorMessage } from '../lib/errorMessage.js'
import { logger } from '../lib/logger.js'

/** The facts a failed run carries at the dispatch edge. `reason` (the message/tail) is the richest signal. */
export interface FailureFacts {
  readonly noun: string
  /** '' for a flat subcommand with no sub-verb. */
  readonly verb: string
  readonly code: number
  /** Constructor name of a thrown error, when the run threw. Absent on a non-throw exit. */
  readonly errorClass?: string
  /** The fault message / output tail. The single most-identifying field. */
  readonly reason?: string
}

/** One signature: a predicate over the lowercased haystack + raw facts, and the hint it yields. */
interface FailureSignature {
  readonly name: string
  /** WHY this class maps to its hint — inline so the list is auditable + extendable. */
  readonly why: string
  readonly matches: (input: { readonly haystack: string; readonly facts: FailureFacts }) => boolean
  readonly hint: (input: { readonly facts: FailureFacts }) => string
}

/**
 * A SCREAMING_SNAKE_CASE env-var name lifted out of a "set FOO_TOKEN" message, so the auth hint can name
 * the exact var to set. Requires at least one underscore so it never grabs a stray uppercase word.
 */
function envVarFrom(reason: string | undefined): string | undefined {
  if (reason === undefined) {
    return undefined
  }
  return reason.match(/\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+)+\b/)?.[0]
}

/**
 * The signature list. First match wins, so order from most-specific cause to least. Each pattern is a
 * family of substrings/regex that identifies the CLASS, not a single message.
 */
const FAILURE_SIGNATURES: readonly FailureSignature[] = [
  {
    name: 'lock-or-contention',
    why: 'a DB/file lock held by a concurrent run — the same work passes clean by hand',
    matches: ({ haystack }) =>
      /conflicting lock|could not (?:set|acquire)\b[^\n]*\block|database is locked|resource temporarily unavailable|\bebusy\b|\beexist\b/.test(haystack),
    hint: () => 'likely contention — retry once; the referenced lock is held by another run',
  },
  {
    name: 'benign-not-found',
    why: 'an API `*_not_found` (repo/resource) — the target is simply absent, not a code fault',
    matches: ({ haystack }) => /\b[a-z]+_not_found\b/.test(haystack),
    hint: () => 'benign not-found — the referenced resource is absent, not a fault',
  },
  {
    name: 'missing-auth',
    why: 'an auth credential is absent (token missing / not authed / invalid)',
    matches: ({ haystack }) =>
      /token missing|missing token|not_authed|invalid_auth|not authenticated|\bunauthori[sz]ed\b|bad credentials/.test(haystack),
    hint: ({ facts }) => {
      const env = envVarFrom(facts.reason)
      return env === undefined
        ? 'missing auth — set the required token env var (the message names which), or run `gh auth login`'
        : `missing auth — set ${env}, or run \`gh auth login\``
    },
  },
]

/**
 * Pure: the one-line hint for a failed run, or null when no known signature matches (stay quiet). Never
 * throws; never reads/writes anything.
 */
export function failureHint(facts: FailureFacts): string | null {
  const haystack = `${facts.reason ?? ''}\n${facts.errorClass ?? ''}`.toLowerCase()
  for (const signature of FAILURE_SIGNATURES) {
    if (signature.matches({ haystack, facts })) {
      return signature.hint({ facts })
    }
  }
  return null
}

/** noun (argv[2]) and the verb (argv[3] only when it is a real sub-verb, not a flag). */
function nounVerbOf(argv: readonly string[]): { readonly noun: string; readonly verb: string } {
  const noun = argv[2] ?? ''
  const candidate = argv[3]
  return { noun, verb: candidate !== undefined && !candidate.startsWith('-') ? candidate : '' }
}

/**
 * The IO edge the CLI dispatch site wires in: build the facts from argv + exit code + any thrown error,
 * compute the hint, and (if any) print it to stderr AFTER the verb's own output. Best-effort and
 * side-effect-only: it logs at most one line and returns void, so it can NEVER alter the real exit code.
 */
export function surfaceFailureHint(input: { readonly argv: readonly string[]; readonly code: number; readonly error?: unknown }): void {
  const { noun, verb } = nounVerbOf(input.argv)
  const hint = failureHint({
    noun,
    verb,
    code: input.code,
    ...(input.error === undefined ? {} : { errorClass: input.error instanceof Error ? input.error.constructor.name : 'unknown' }),
    ...(input.error === undefined ? {} : { reason: errorMessage(input.error) }),
  })
  if (hint !== null) {
    logger.error(hint)
  }
}
