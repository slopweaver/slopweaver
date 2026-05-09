/**
 * `safeQuery` — exception-to-`Result` bridge for better-sqlite3 / Drizzle calls.
 *
 * Wraps a `Promise<T>` (or synchronous Drizzle call) in
 * `ResultAsync<T, DatabaseError>`. On failure, walks the error's `.cause`
 * chain via `extractSqliteErrorShape` to pull SQLite-specific fields
 * (`SQLITE_CONSTRAINT_UNIQUE`, table name, constraint column), then
 * returns a uniform `DatabaseError` from `@slopweaver/errors`.
 *
 * This is the DB counterpart to `safeApiCall` (which lives in
 * `@slopweaver/errors` because it's storage-agnostic). `safeQuery` lives
 * here because the better-sqlite3 dependency belongs to this package.
 *
 * Service code should never use `try`/`catch` around a Drizzle call — use
 * `safeQuery` instead, then `.mapErr()` to a domain error if the raw
 * `DatabaseError` shape is not what the caller wants.
 *
 * @example
 * ```ts
 * const result = safeQuery({
 *   execute: () =>
 *     db.insert(integrationTokens).values({ … }).run(),
 * });
 * if (result.isErr() && result.error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
 *   // …
 * }
 * ```
 *
 * Drizzle's better-sqlite3 driver is synchronous, so `execute` may return
 * a plain `T` — the wrapper handles both via `Promise.resolve().then`.
 */

import type { DatabaseError } from '@slopweaver/errors';
import { ResultAsync } from '@slopweaver/errors';
import { extractSqliteErrorShape } from './sqlite-error.ts';

export function safeQuery<T>({
  execute,
}: {
  execute: () => Promise<T> | T;
}): ResultAsync<T, DatabaseError> {
  return ResultAsync.fromPromise(
    Promise.resolve().then(execute),
    (error): DatabaseError => mapDatabaseError({ error }),
  );
}

function mapDatabaseError({ error }: { error: unknown }): DatabaseError {
  const shape = extractSqliteErrorShape({ error });

  const fallbackMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Database operation failed';

  return {
    cause: error,
    message: shape?.message ?? fallbackMessage,
    ...(shape?.code !== undefined && { code: shape.code }),
    ...(shape?.constraint !== undefined && { constraint: shape.constraint }),
    ...(shape?.detail !== undefined && { detail: shape.detail }),
    ...(shape?.table !== undefined && { table: shape.table }),
  };
}
