/**
 * Slack-domain error union and factories.
 *
 * Discriminated by `code`. Service code returns `Result<T, SlackError>` /
 * `ResultAsync<T, SlackError>`; callers exhaustively match on `code` at the
 * boundary. Mirrors the convention in `slopweaver-private` and the public
 * convention doc at `.claude/rules/error-handling.md`.
 */

import type { ApiCallError, BaseError, DatabaseError, ResultAsync } from '@slopweaver/errors';
import { safeApiCall } from '@slopweaver/errors';

export interface SlackTokenInvalidError extends BaseError {
  readonly code: 'SLACK_TOKEN_INVALID';
  readonly tokenPrefix: string;
}

export interface SlackApiError extends BaseError {
  readonly code: 'SLACK_API_ERROR';
  readonly endpoint: string;
  readonly status?: number;
  readonly slackCode?: string;
  readonly cause?: unknown;
}

export interface SlackDatabaseError extends BaseError {
  readonly code: 'SLACK_DATABASE_ERROR';
  readonly cause?: unknown;
}

export interface SlackPaginationCapError extends BaseError {
  readonly code: 'SLACK_PAGINATION_CAP_EXCEEDED';
  readonly totalPages: number;
  readonly maxPages: number;
}

export interface SlackTsParseError extends BaseError {
  readonly code: 'SLACK_TS_PARSE_FAILED';
  readonly ts: string;
}

export type SlackError =
  | SlackTokenInvalidError
  | SlackApiError
  | SlackDatabaseError
  | SlackPaginationCapError
  | SlackTsParseError;

export const SlackErrors = {
  tokenInvalid: (tokenPrefix: string): SlackTokenInvalidError => ({
    code: 'SLACK_TOKEN_INVALID',
    message: tokenPrefix
      ? `Slack token has unexpected prefix "${tokenPrefix}"; expected xoxp- or xoxb-.`
      : 'Slack token must be a non-empty string.',
    tokenPrefix,
  }),

  apiError: (
    endpoint: string,
    opts: { status?: number; slackCode?: string; cause?: unknown; message?: string } = {},
  ): SlackApiError => ({
    code: 'SLACK_API_ERROR',
    message: opts.message ?? `Slack API call failed: ${endpoint}`,
    endpoint,
    ...(opts.status !== undefined && { status: opts.status }),
    ...(opts.slackCode !== undefined && { slackCode: opts.slackCode }),
    ...(opts.cause !== undefined && { cause: opts.cause }),
  }),

  databaseError: (message: string, cause?: unknown): SlackDatabaseError => ({
    code: 'SLACK_DATABASE_ERROR',
    message,
    ...(cause !== undefined && { cause }),
  }),

  paginationCapExceeded: (totalPages: number, maxPages: number): SlackPaginationCapError => ({
    code: 'SLACK_PAGINATION_CAP_EXCEEDED',
    message: `Slack search returned ${totalPages} pages, exceeds MAX_PAGES=${maxPages}; cursor not advanced. Re-run with a more recent since to recover the tail.`,
    totalPages,
    maxPages,
  }),

  tsParseFailed: (ts: string): SlackTsParseError => ({
    code: 'SLACK_TS_PARSE_FAILED',
    message: `Cannot parse Slack ts: ${ts}`,
    ts,
  }),
} as const;

/**
 * Translate a `DatabaseError` (raw output of `safeQuery`) into a
 * `SlackDatabaseError` so callers see only the SlackError union.
 */
export function fromDatabaseError(dbError: DatabaseError): SlackDatabaseError {
  return SlackErrors.databaseError(dbError.message, dbError.cause);
}

/**
 * Slack-aware wrapper around `safeApiCall`. Tags the failure with the
 * endpoint and pulls Slack's `data.error` (the SDK's `WebAPIPlatformError`
 * shape) so callers can distinguish e.g. `not_allowed_token_type` from
 * other API failures by `slackCode`.
 */
export function safeSlackCall<T>({
  execute,
  endpoint,
}: {
  execute: () => Promise<T> | T;
  endpoint: string;
}): ResultAsync<T, SlackApiError> {
  return safeApiCall({
    execute,
    provider: 'slack',
    extractError: ({ error }) => {
      if (error === null || typeof error !== 'object') return {};
      const e = error as { code?: unknown; data?: { error?: unknown }; status?: unknown };
      const status = typeof e.status === 'number' ? e.status : undefined;
      const slackCode =
        typeof e.data?.error === 'string'
          ? e.data.error
          : typeof e.code === 'string'
            ? e.code
            : undefined;
      const out: Partial<ApiCallError> = {
        ...(status !== undefined && { status }),
        ...(slackCode !== undefined && { code: slackCode }),
      };
      return out;
    },
  }).mapErr(
    (apiErr): SlackApiError =>
      SlackErrors.apiError(endpoint, {
        ...(apiErr.status !== undefined && { status: apiErr.status }),
        ...(apiErr.code !== undefined && { slackCode: apiErr.code }),
        cause: apiErr.cause,
        message: apiErr.message,
      }),
  );
}
