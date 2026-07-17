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
