/**
 * Shared error type primitives.
 *
 * Every domain error interface in the monorepo extends `BaseError`. The
 * `code` field is the discriminant — exhaustive `.match()` / switch on
 * `code` is how callers handle error unions without ad-hoc string
 * comparison.
 *
 * `ApiCallError` and `DatabaseError` are the raw output shapes of the
 * boundary wrappers (`safeApiCall` here, `safeQuery` in `@slopweaver/db`).
 * Service layers `.mapErr()` these into their own domain-specific
 * code'd errors when needed.
 */

export interface BaseError {
  readonly code: string;
  readonly message: string;
}

export interface ApiCallError {
  readonly message: string;
  readonly provider: string;
  readonly cause?: unknown;
  readonly status?: number;
  readonly code?: string;
}

export interface DatabaseError {
  readonly message: string;
  readonly cause?: unknown;
  readonly code?: string;
  readonly constraint?: string;
  readonly detail?: string;
  readonly table?: string;
}
