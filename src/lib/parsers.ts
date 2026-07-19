/** Small type-narrowing predicates shared across the CLI spine. Pure: no I/O, no state. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}
