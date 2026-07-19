import { type Result as NtResult, type ResultAsync as NtResultAsync, err as ntErr, ok as ntOk } from "neverthrow";

export type Result<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly warnings: readonly string[];
    }
  | {
      readonly ok: false;
      readonly errors: readonly string[];
      readonly warnings: readonly string[];
    };

/**
 * The typed, cause-preserving result — neverthrow's `Result`, aliased under a distinct name so it lives
 * ALONGSIDE the repo's warning-bearing {@link Result} (PR3.6 adds it additively, no flag-day replace).
 * Used by the `safe*` boundary wrappers so every external throw becomes a typed {@link IngestError}, its
 * status/code/cause preserved rather than flattened to a string. `E` defaults to `IngestError`'s slot but
 * is left generic here (the wrappers pin it) to keep this module dependency-free of the error union.
 */
export type TypedResult<T, E> = NtResult<T, E>;

/** The async sibling of {@link TypedResult} — a promise of a typed result (the `safe*` wrappers return it). */
export type TypedResultAsync<T, E> = NtResultAsync<T, E>;

/**
 * Construct a typed success. A library-pattern primitive (positional, like {@link ok}) — a thin re-export
 * of neverthrow's `ok` under a distinct name so call-sites read `typedOk`, not an aliased import.
 *
 * @param value the success value
 * @returns a typed `Ok`
 */
export function typedOk<T, E = never>(value: T): TypedResult<T, E> {
  return ntOk(value);
}

/**
 * Construct a typed error. The error-branch sibling of {@link typedOk} (positional, library-pattern).
 *
 * @param error the typed error value
 * @returns a typed `Err`
 */
export function typedErr<T = never, E = unknown>(error: E): TypedResult<T, E> {
  return ntErr(error);
}

export function ok<T>(value: T, warnings: readonly string[] = []): Result<T> {
  return { ok: true, value, warnings };
}

export function err<T>(errors: readonly string[], warnings: readonly string[] = []): Result<T> {
  return { errors, ok: false, warnings };
}

/**
 * Unwrap a successful `Result`'s value, THROWING if it is an error. A monadic combinator (positional,
 * like the `ok`/`err` constructors above), used where the caller is certain of success — chiefly tests,
 * which assert `.ok` first, then unwrap without a branch (keeps assertions falsifiable + conditional-free).
 *
 * @param result the Result to unwrap
 * @returns the success value
 */
export function unwrap<T>(result: Result<T>): T {
  if (result.ok === false) {
    throw new Error(`unwrap called on an error Result: ${result.errors.join("; ")}`);
  }
  return result.value;
}

/**
 * Unwrap an error `Result`'s errors, THROWING if it is a success. The error-branch sibling of {@link unwrap}.
 *
 * @param result the Result to unwrap
 * @returns the error messages
 */
export function unwrapErr<T>(result: Result<T>): readonly string[] {
  if (result.ok === true) {
    throw new Error("unwrapErr called on a success Result");
  }
  return result.errors;
}
