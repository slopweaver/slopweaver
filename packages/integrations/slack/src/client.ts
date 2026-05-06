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
}): WebClient {
  if (!token) {
    throw new Error('createSlackClient: token must be a non-empty string');
  }
  const resolvedRetryConfig =
    retryConfig ?? (process.env['NODE_ENV'] === 'test' ? TEST_RETRY_CONFIG : PROD_RETRY_CONFIG);
  return new WebClient(token, { retryConfig: resolvedRetryConfig });
}
