/**
 * `safeApiCall` — exception-to-`Result` bridge for external API/SDK calls.
 *
 * Wraps a `Promise<T>` (or synchronous value) in
 * `ResultAsync<T, ApiCallError>`. On failure, an optional per-SDK
 * `extractError` callback pulls structured fields (HTTP status, vendor
 * error code) out of the raw exception; the wrapper then fills in
 * `provider`, `message`, and `cause` to produce a uniform `ApiCallError`.
 *
 * This is the external-API counterpart to `safeQuery` (which lives in
 * `@slopweaver/db` because the better-sqlite3 dependency belongs there).
 * Service code should never use `try`/`catch` around a vendor SDK call —
 * use `safeApiCall` instead, then `.mapErr()` to a domain error if the
 * raw `ApiCallError` shape is not what the caller wants.
 *
 * @example
 * ```ts
 * const result = safeApiCall({
 *   execute: () => slack.search.messages({ query, count: 100 }),
 *   provider: 'slack',
 *   extractError: ({ error }) =>
 *     error instanceof WebAPIPlatformError
 *       ? { code: error.data?.error ?? 'SLACK_API_ERROR' }
 *       : {},
 * });
 * ```
 */

import { ResultAsync } from 'neverthrow';
import type { ApiCallError } from './types.ts';

export function safeApiCall<T>({
  execute,
  provider,
  extractError,
}: {
  execute: () => Promise<T> | T;
  provider: string;
  extractError?: ({ error }: { error: unknown }) => Partial<ApiCallError>;
}): ResultAsync<T, ApiCallError> {
  return ResultAsync.fromPromise(
    Promise.resolve().then(execute),
    (error): ApiCallError => mapApiCallError({ error, extractError, provider }),
  );
}

function mapApiCallError({
  error,
  provider,
  extractError,
}: {
  error: unknown;
  provider: string;
  extractError?: (({ error }: { error: unknown }) => Partial<ApiCallError>) | undefined;
}): ApiCallError {
  const extracted = extractError?.({ error }) ?? {};

  const fallbackMessage =
    error instanceof Error ? error.message : typeof error === 'string' ? error : 'API call failed';

  return {
    ...extracted,
    cause: error,
    message: extracted.message ?? fallbackMessage,
    provider,
  };
}
