/**
 * Shared arg parsing for the query verbs (`ask`, `facts`): a free-text QUESTION (all non-flag tokens,
 * joined) plus flags. Tokenising is delegated to {@link tokenizeFlags} (Node's `parseArgs`) with
 * positionals kept as the question; this module adds the value validators (positive-int, fraction, …).
 * Pure — errors are accumulated, not thrown.
 */
import { tokenizeFlags } from '../parseFlags.js'

export interface QueryArgs {
  readonly home?: string
  readonly corpus?: string
  readonly limit: number
  readonly alpha?: number
  readonly semantic: boolean
  /** Emit one machine-readable JSON object on stdout instead of the pretty answer. */
  readonly json: boolean
  readonly halfLifeDays?: number
  readonly question: string
  readonly errors: readonly string[]
}

function positiveInt({ raw, label, errors, fallback }: { raw: string; label: string; errors: string[]; fallback: number }): number {
  const parsed = Number(raw)
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }
  errors.push(`${label} must be a positive integer`)
  return fallback
}

function fraction({ raw, label, errors }: { raw: string; label: string; errors: string[] }): number | undefined {
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed >= 0 && parsed <= 1) {
    return parsed
  }
  errors.push(`${label} must be between 0 and 1`)
  return undefined
}

function positiveNumber({ raw, label, errors }: { raw: string; label: string; errors: string[] }): number | undefined {
  const parsed = Number(raw)
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  errors.push(`${label} must be a positive number`)
  return undefined
}

/** Read a string-valued flag from the tokenised values (booleans/absent ⇒ undefined). */
function stringValue({ values, key }: { values: Readonly<Record<string, string | boolean>>; key: string }): string | undefined {
  const value = values[key]
  return typeof value === 'string' ? value : undefined
}

/**
 * Parse a query verb's argv tail into a question + flags.
 *
 * @param rest the argv tail (after the noun)
 * @param defaultLimit the default slice size
 * @returns the parsed args (with accumulated `errors`)
 */
export function parseQueryArgs({ rest, defaultLimit }: { rest: readonly string[]; defaultLimit: number }): QueryArgs {
  const { values, positionals, errors: tokenErrors } = tokenizeFlags({
    args: rest,
    spec: { string: ['home', 'corpus', 'limit', 'alpha', 'half-life-days'], boolean: ['no-semantic', 'json'] },
    allowPositionals: true,
  })
  const errors = [...tokenErrors]
  const home = stringValue({ values, key: 'home' })
  const corpus = stringValue({ values, key: 'corpus' })
  const limitRaw = stringValue({ values, key: 'limit' })
  const alphaRaw = stringValue({ values, key: 'alpha' })
  const halfLifeRaw = stringValue({ values, key: 'half-life-days' })

  return {
    ...(home !== undefined ? { home } : {}),
    ...(corpus !== undefined ? { corpus } : {}),
    limit: limitRaw !== undefined ? positiveInt({ raw: limitRaw, label: '--limit', errors, fallback: defaultLimit }) : defaultLimit,
    ...(alphaRaw !== undefined ? { alpha: fraction({ raw: alphaRaw, label: '--alpha', errors }) } : {}),
    semantic: values['no-semantic'] !== true,
    json: values.json === true,
    ...(halfLifeRaw !== undefined ? { halfLifeDays: positiveNumber({ raw: halfLifeRaw, label: '--half-life-days', errors }) } : {}),
    question: positionals.join(' '),
    errors,
  }
}
