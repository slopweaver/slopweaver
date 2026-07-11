/**
 * Generic argv-tail parsing helpers shared by verbs. Pure: no I/O. Each verb parses its own tail with
 * these rather than hand-rolling a loop, so an unknown flag or a dropped value is REJECTED (returned as
 * an error) instead of silently ignored — the trap a mistyped `--gruop-by` or a swallowed value hides.
 */
import { isOneOf } from '../lib/parsers.js'
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
 * MISSING value, or a stray positional — instead of silently dropping them.
 */
export function parseFlagTail(rest: readonly string[], spec: FlagTailSpec): Result<ParsedFlagTail> {
  const valueFlags = new Set(spec.value)
  const boolFlags = new Set(spec.boolean ?? [])
  const values: Record<string, string> = {}
  const flags = new Set<string>()
  const errors: string[] = []
  let i = 0
  while (i < rest.length) {
    const token = rest[i]
    if (token === undefined) {
      i += 1
      continue
    }
    if (!token.startsWith('--')) {
      errors.push(`unexpected argument: ${token}`)
      i += 1
      continue
    }
    const key = token.slice(2)
    if (boolFlags.has(key)) {
      flags.add(key)
      i += 1
      continue
    }
    if (valueFlags.has(key)) {
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) {
        errors.push(`missing value for ${token}`)
        i += 1
        continue
      }
      values[key] = value
      i += 2
      continue
    }
    errors.push(`unknown flag: ${token}`)
    i += 1
  }
  return errors.length > 0 ? err(errors) : ok({ values, flags })
}

export function requireNext(arg: string, value: string | undefined, errors: string[]): string {
  if (value === undefined || value.startsWith('--')) {
    errors.push(`${arg} requires a value`)
    return ''
  }
  return value
}

/** Read the value token AFTER a flag at `index`, recording an error when it's missing or itself a flag. */
export function takeValue(tail: readonly string[], index: number, flag: string, errors: string[]): string | undefined {
  const next = tail[index + 1]
  if (next === undefined || next.startsWith('--')) {
    errors.push(`${flag} requires a value`)
    return undefined
  }
  return next
}

export function parseList<T extends string>(
  { value, allowed, label, errors }: { value: string; allowed: readonly T[]; label: string; errors: string[] },
): readonly T[] {
  if (value.trim().length === 0) {
    return []
  }
  const parsed: T[] = []
  for (const item of value.split(',')) {
    const trimmed = item.trim()
    if (isOneOf(trimmed, allowed)) {
      parsed.push(trimmed)
    } else {
      errors.push(`unsupported ${label}: ${trimmed}`)
    }
  }
  return [...new Set(parsed)]
}

export function parsePositiveInteger({ value, label, errors }: { value: string; label: string; errors: string[] }): number {
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }
  errors.push(`${label} must be a positive integer`)
  return 50
}

export function parseFreeformList(value: string): readonly string[] {
  return [...new Set(
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0),
  )]
}
