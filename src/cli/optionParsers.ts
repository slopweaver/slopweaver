/**
 * Verb-tail parsing helpers. Tokenising is delegated to {@link parseFlags} (built on Node's `parseArgs`),
 * so verbs never hand-roll a `--flag value` loop again; this module keeps the small VALUE validators
 * (positive-integer, etc.) that turn a raw flag string into a checked number with a domain error.
 */
import { parseFlags } from './parseFlags.js'
import { err, ok, type Result } from '../lib/result.js'

export interface FlagTailSpec {
  /** Flag names (without the `--`) that take a value. */
  readonly value: readonly string[]
  /** Flag names (without the `--`) that are boolean switches. */
  readonly boolean?: readonly string[]
}

export interface ParsedFlagTail {
  readonly values: Readonly<Record<string, string>>
  readonly flags: ReadonlySet<string>
}

/**
 * Parse a `--flag value` / `--switch` tail into a validated bag, returning `err` for an UNKNOWN flag, a
 * MISSING value, or a stray positional — instead of silently dropping them. Thin adapter over
 * {@link parseFlags}: string flags become `values`, boolean switches become `flags`.
 *
 * @param rest the argv tail (verb args, after `node cli noun verb`)
 * @param spec the value + boolean flag names to accept
 * @returns the parsed `{ values, flags }`, or an error listing every rejection
 */
export function parseFlagTail({ rest, spec }: { rest: readonly string[]; spec: FlagTailSpec }): Result<ParsedFlagTail> {
  const parsed = parseFlags({ args: rest, spec: { string: spec.value, boolean: spec.boolean ?? [] }, allowPositionals: false })
  if (parsed.ok === false) {
    return err(parsed.errors)
  }
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  for (const [key, value] of Object.entries(parsed.value.values)) {
    if (typeof value === 'string') {
      values[key] = value
    } else {
      flags.add(key)
    }
  }
  return ok({ values, flags })
}

/**
 * Parse a flag value as a positive integer, pushing a domain error (and returning a fallback) when it
 * isn't one.
 *
 * @param value the raw flag value
 * @param label the flag name (for the error message)
 * @param errors the error accumulator to push into
 * @returns the parsed positive integer, or `50` as a fallback
 */
export function parsePositiveInteger({ value, label, errors }: { value: string; label: string; errors: string[] }): number {
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }
  errors.push(`${label} must be a positive integer`)
  return 50
}
