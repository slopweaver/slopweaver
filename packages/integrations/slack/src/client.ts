/**
 * Construct a configured `@slack/web-api` `WebClient`.
 *
 * Thin factory around the SDK constructor so callers don't have to remember
 * the retry config. Production runs use exponential-backoff retries; tests
 * default to `retries: 0` so failed cassette matches surface immediately
 * instead of hanging on the SDK's default backoff. Callers can override via
 * `retryConfig`.
 *
 * The retry config shape mirrors the private monorepo's `slack-client.provider.ts`
 * so both repos behave the same against a real workspace.
 */

import { WebClient, type WebClientOptions } from '@slack/web-api';
import { err, ok, type Result } from '@slopweaver/errors';
import { SlackErrors, type SlackTokenInvalidError } from './errors.ts';

type RetryConfig = NonNullable<WebClientOptions['retryConfig']>;

const PROD_RETRY_CONFIG: RetryConfig = {
  retries: 3,
  factor: 2,
  minTimeout: 1_000,
  maxTimeout: 30_000,
};

const TEST_RETRY_CONFIG: RetryConfig = {
  retries: 0,
};

export function createSlackClient({
  token,
  retryConfig,
}: {
  token: string;
  retryConfig?: RetryConfig;
}): Result<WebClient, SlackTokenInvalidError> {
  if (!token) {
    return err(SlackErrors.tokenInvalid(''));
  }
  const resolvedRetryConfig =
    retryConfig ?? (process.env['NODE_ENV'] === 'test' ? TEST_RETRY_CONFIG : PROD_RETRY_CONFIG);
  return ok(new WebClient(token, { retryConfig: resolvedRetryConfig }));
}
