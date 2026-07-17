/**
 * The one flag parser, built on Node's built-in `node:util` `parseArgs` — so verbs never hand-roll
 * `rest.indexOf('--x')` / `startsWith('--')` loops again. It runs `parseArgs` in non-strict mode (so it
 * never throws) and folds the result into this repo's `Result` + error-list style:
 *   - an unknown flag → `unknown flag: --x`
 *   - a value flag given with no value → `--x requires a value`
 *   - a stray positional when positionals aren't allowed → `unexpected argument: x`
 * When positionals ARE allowed (the query verbs' free-text tail), they're returned for the caller to join.
 *
 * Pure: no I/O. `parseArgs` is a stdlib primitive used positionally, so it's exempt from the named-object
 * rule the way `logger.info(msg)` is; everything here otherwise follows the house style.
 */
import { parseArgs } from 'node:util'

import { err, ok, type Result } from '../lib/result.js'

/** Which flags take a value (`--home x`) vs are boolean switches (`--json`). Names omit the `--`. */
export interface FlagSpec {
  readonly string?: readonly string[]
  readonly boolean?: readonly string[]
}

/** Parsed flags: declared values (string or boolean), plus any positionals (for a free-text tail). */
export interface ParsedFlags {
  readonly values: Readonly<Record<string, string | boolean>>
  readonly positionals: readonly string[]
}

/** The raw tokenizer result — values + positionals + accumulated errors, WITHOUT short-circuiting. */
export interface FlagTokens extends ParsedFlags {
  readonly errors: readonly string[]
}

/**
 * Tokenise an argv tail against a flag spec, ACCUMULATING every rejection (never short-circuits, so a
 * caller can add its own value-validation errors to the same list). Never throws.
 *
 * @param args the argv tail (after the noun/verb)
 * @param spec the string + boolean flag names to accept
 * @param allowPositionals keep positionals (true, for a free-text tail) or reject them as errors (false)
 * @returns `{ values, positionals, errors }`
 */
export function tokenizeFlags(
  { args, spec, allowPositionals = false }: { args: readonly string[]; spec: FlagSpec; allowPositionals?: boolean },
): FlagTokens {
  const stringKeys = new Set(spec.string ?? [])
  const boolKeys = new Set(spec.boolean ?? [])
  const options: Record<string, { type: 'string' | 'boolean' }> = {}
  for (const key of stringKeys) {
    options[key] = { type: 'string' }
  }
  for (const key of boolKeys) {
    options[key] = { type: 'boolean' }
  }

  // strict:false ⇒ unknown flags land in `values` (as `true`) and missing string values become `true`,
  // rather than throwing — we turn both into our own domain errors below.
  const parsed = parseArgs({ args: [...args], options, strict: false, allowPositionals: true })

  const errors: string[] = []
  const values: Record<string, string | boolean> = {}
  for (const [key, value] of Object.entries(parsed.values)) {
    if (!stringKeys.has(key) && !boolKeys.has(key)) {
      errors.push(`unknown flag: --${key}`)
      continue
    }
    if (value === undefined) {
      continue
    }
    // A value flag with no value → parseArgs yields `true`; and a value flag that "ate" the NEXT flag
    // (`--home --json` ⇒ home:'--json') is also a missing value. Reject both, matching the prior behaviour.
    if (stringKeys.has(key) && (typeof value !== 'string' || value.startsWith('--'))) {
      errors.push(`--${key} requires a value`)
      continue
    }
    values[key] = value
  }
  if (!allowPositionals) {
    for (const positional of parsed.positionals) {
      errors.push(`unexpected argument: ${positional}`)
    }
  }
  return { values, positionals: parsed.positionals, errors }
}

/**
 * Parse an argv tail against a flag spec, as a `Result`. The short-circuiting wrapper over
 * {@link tokenizeFlags} for verbs that reject on any bad flag.
 *
 * @param args the argv tail (after the noun/verb)
 * @param spec the string + boolean flag names to accept
 * @param allowPositionals keep positionals (true) or reject them as errors (false)
 * @returns the parsed `{ values, positionals }`, or an error listing every rejection
 */
export function parseFlags(
  { args, spec, allowPositionals = false }: { args: readonly string[]; spec: FlagSpec; allowPositionals?: boolean },
): Result<ParsedFlags> {
  const { values, positionals, errors } = tokenizeFlags({ args, spec, allowPositionals })
  return errors.length > 0 ? err(errors) : ok({ values, positionals })
}
