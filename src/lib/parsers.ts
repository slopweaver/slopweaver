/** Small type-narrowing predicates shared across the CLI spine. Pure: no I/O, no state. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Narrows a caught `unknown` to a Node errno (`{ code?: string }`) so the `.code`
 * (ENOENT/EEXIST/...) can be read without an `as`. `'code' in value` does the narrowing;
 * we deliberately do NOT require `instanceof Error`, since fs/spawn errno objects are the
 * thing we branch on and not all carry the Error prototype across realms.
 */
export function isErrno(value: unknown): value is NodeJS.ErrnoException {
  return typeof value === "object" && value !== null && "code" in value;
}

export function isOneOf<T extends string>(value: string, allowed: readonly T[]): value is T {
  return allowed.some((item) => item === value);
}
