/**
 * Smoke tests for createSlackClient.
 *
 * The wire-level concerns (bearer auth, 429 retry, JSON encoding,
 * { ok: false } -> WebAPIPlatformError) live in `@slack/web-api` itself; we
 * don't re-test them. These tests only pin our thin factory.
 */

import { WebClient } from '@slack/web-api';
import { describe, expect, it } from 'vitest';
import { createSlackClient } from './client.ts';

describe('createSlackClient', () => {
  it('returns ok with a WebClient instance', () => {
    const result = createSlackClient({ token: 'xoxb-test' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBeInstanceOf(WebClient);
    }
  });

  it('returns err with SLACK_TOKEN_INVALID when token is empty', () => {
    const result = createSlackClient({ token: '' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('SLACK_TOKEN_INVALID');
    }
  });

  it('accepts a custom retryConfig override', () => {
    const result = createSlackClient({
      token: 'xoxb-test',
      retryConfig: { retries: 7 },
    });
    // The SDK doesn't expose the resolved retry config, so we settle for the
    // construction-doesn't-fail assertion. The real behaviour is exercised
    // by integration tests against cassettes.
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBeInstanceOf(WebClient);
    }
  });
});
