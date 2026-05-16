/**
 * GitHub-domain error union and factories.
 *
 * Discriminated by `code`. Mirrors the Slack package's shape so the public
 * surface across integrations is uniform. `safeGithubCall` wraps Octokit
 * calls, lifting `@octokit/request-error` instances (RequestError) into a
 * structured `GithubApiError` carrying the HTTP status.
 */

import type { ApiCallError, BaseError, DatabaseError, ResultAsync } from '@slopweaver/errors';
import { safeApiCall } from '@slopweaver/errors';

export interface GithubApiError extends BaseError {
  readonly code: 'GITHUB_API_ERROR';
  readonly endpoint: string;
  readonly status?: number;
  readonly cause?: unknown;
}

export interface GithubDatabaseError extends BaseError {
  readonly code: 'GITHUB_DATABASE_ERROR';
  readonly cause?: unknown;
}

export type GithubError = GithubApiError | GithubDatabaseError;

const GithubErrors = {
  apiError: (
    endpoint: string,
    opts: { status?: number; cause?: unknown; message?: string } = {},
  ): GithubApiError => ({
    code: 'GITHUB_API_ERROR',
    message: opts.message ?? `GitHub API call failed: ${endpoint}`,
    endpoint,
    ...(opts.status !== undefined && { status: opts.status }),
    ...(opts.cause !== undefined && { cause: opts.cause }),
  }),

  databaseError: (message: string, cause?: unknown): GithubDatabaseError => ({
    code: 'GITHUB_DATABASE_ERROR',
    message,
    ...(cause !== undefined && { cause }),
  }),
} as const;

export function fromDatabaseError(dbError: DatabaseError): GithubDatabaseError {
  return GithubErrors.databaseError(dbError.message, dbError.cause);
}

/**
 * GitHub-aware wrapper around `safeApiCall`. Tags failure with the endpoint
 * and pulls Octokit's `RequestError.status` so callers can branch on HTTP
 * status without inspecting the raw exception.
 */
export function safeGithubCall<T>({
  execute,
  endpoint,
}: {
  execute: () => Promise<T> | T;
  endpoint: string;
}): ResultAsync<T, GithubApiError> {
  return safeApiCall({
    execute,
    provider: 'github',
    extractError: ({ error }) => {
      if (error === null || typeof error !== 'object') return {};
      const e = error as { status?: unknown; name?: unknown };
      const status = typeof e.status === 'number' ? e.status : undefined;
      const out: Partial<ApiCallError> = {
        ...(status !== undefined && { status }),
      };
      return out;
    },
  }).mapErr(
    (apiErr): GithubApiError =>
      GithubErrors.apiError(endpoint, {
        ...(apiErr.status !== undefined && { status: apiErr.status }),
        cause: apiErr.cause,
        message: apiErr.message,
      }),
  );
}
