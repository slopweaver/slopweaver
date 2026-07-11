/**
 * Canonical "turn a caught `unknown` into a string" helper. Routing every catch through one seam means
 * a future change (surfacing `error.cause`, stripping a noisy prefix) lands in one place.
 *
 * `instanceof Error` is deliberate over reading `.message` off any object: a non-Error throw (a string,
 * a number, a plain `{ code }` errno) stringifies predictably rather than yielding `undefined`.
 *
 * @param error the caught unknown
 * @returns a display string for it
 */
export function errorMessage({ error }: { error: unknown }): string {
  return error instanceof Error ? error.message : String(error)
}
