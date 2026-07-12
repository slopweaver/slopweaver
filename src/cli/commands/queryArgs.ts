/**
 * Shared arg parsing for the query verbs (`ask`, `facts`): a free-text QUESTION (all non-flag tokens,
 * joined) plus flags. Unlike `parseFlagTail`, this keeps positional tokens as the question rather than
 * rejecting them. Pure — errors are accumulated, not thrown.
 */

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

/**
 * Parse a query verb's argv tail into a question + flags.
 *
 * @param rest the argv tail (after the noun)
 * @param defaultLimit the default slice size
 * @returns the parsed args (with accumulated `errors`)
 */
export function parseQueryArgs({ rest, defaultLimit }: { rest: readonly string[]; defaultLimit: number }): QueryArgs {
  const errors: string[] = []
  const values: Record<string, string> = {}
  const valueFlags = new Set(['home', 'corpus', 'limit', 'alpha', 'half-life-days'])
  const questionParts: string[] = []
  let semantic = true
  let json = false

  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i] ?? ''
    if (token === '--no-semantic') {
      semantic = false
    } else if (token === '--json') {
      json = true
    } else if (token.startsWith('--')) {
      const key = token.slice(2)
      if (!valueFlags.has(key)) {
        errors.push(`unknown flag: ${token}`)
        continue
      }
      const value = rest[i + 1]
      if (value === undefined || value.startsWith('--')) {
        errors.push(`${token} requires a value`)
      } else {
        values[key] = value
        i += 1
      }
    } else {
      questionParts.push(token)
    }
  }

  return {
    ...(values.home !== undefined ? { home: values.home } : {}),
    ...(values.corpus !== undefined ? { corpus: values.corpus } : {}),
    limit: values.limit !== undefined ? positiveInt({ raw: values.limit, label: '--limit', errors, fallback: defaultLimit }) : defaultLimit,
    ...(values.alpha !== undefined ? { alpha: fraction({ raw: values.alpha, label: '--alpha', errors }) } : {}),
    semantic,
    json,
    ...(values['half-life-days'] !== undefined ? { halfLifeDays: positiveNumber({ raw: values['half-life-days'], label: '--half-life-days', errors }) } : {}),
    question: questionParts.join(' '),
    errors,
  }
}
