export type Result<T> =
  | {
    readonly ok: true
    readonly value: T
    readonly warnings: readonly string[]
  }
  | {
    readonly ok: false
    readonly errors: readonly string[]
    readonly warnings: readonly string[]
  }

export function ok<T>(value: T, warnings: readonly string[] = []): Result<T> {
  return { ok: true, value, warnings }
}

export function err<T>(errors: readonly string[], warnings: readonly string[] = []): Result<T> {
  return { ok: false, errors, warnings }
}

export function resultErrors<T>(result: Result<T>): readonly string[] {
  if (result.ok === true) {
    return []
  }
  return result.errors
}
