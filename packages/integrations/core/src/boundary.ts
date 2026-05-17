/**
 * `Result`-to-throwing-callback boundary helper.
 *
 * Integration pollers are wired into the host via a throw-based callback
 * signature (the cron loop in `start_session` catches per-platform throws
 * to isolate them — see `.claude/rules/error-handling.md`). But the inner
 * `pollMentions` / `pollDMs` etc. functions return `ResultAsync<_, ErrUnion>`
 * per the service-boundary rule (no throws in service files).
 *
 * This helper bridges the two: when the inner `Result` is `Err`, the
 * caller invokes `rejectBoundaryError(error)` and returns the rejected
 * Promise. The returned `Error` instance preserves the typed Result error
 * as `.cause` so logs / diagnostics retain the structured fields.
 *
 * The implementation uses `return Promise.reject(...)` rather than `throw`
 * for one specific architectural reason: the surrounding poller files are
 * scanned by `check-service-boundaries`, which forbids `throw` keywords.
 * `Promise.reject` from within an `async` function is semantically
 * equivalent but lexically not a throw. This is the SOLE sanctioned use
 * of that pattern; everything else should use a Result and let the caller
 * handle the Err arm.
 */

export interface BoundaryError {
  readonly code: string;
  readonly message: string;
}

/**
 * Wrap a typed `Result` error in an `Error` (so the catching cron-loop sees
 * a proper Error subclass with stack), preserve the original as `cause`, and
 * return the rejected Promise. Designed to be `return`ed from inside an
 * `async` callback passed to the host's throw-based API.
 *
 * @example
 *   const result = await poll(...);
 *   if (result.isErr()) {
 *     return rejectBoundaryError({ error: result.error });
 *   }
 */
export async function rejectBoundaryError({ error }: { error: BoundaryError }): Promise<never> {
  return Promise.reject(new Error(`${error.code}: ${error.message}`, { cause: error }));
}
