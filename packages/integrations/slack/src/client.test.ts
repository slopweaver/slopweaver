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
  it('returns a WebClient instance', () => {
    const client = createSlackClient({ token: 'xoxb-test' });
    expect(client).toBeInstanceOf(WebClient);
  });

  it('rejects empty tokens at construction time', () => {
    expect(() => createSlackClient({ token: '' })).toThrowError(/non-empty string/);
  });

  it('accepts a custom retryConfig override', () => {
    const client = createSlackClient({
      token: 'xoxb-test',
      retryConfig: { retries: 7 },
    });
    // The SDK doesn't expose the resolved retry config, so we settle for the
    // construction-doesn't-throw assertion. The real behaviour is exercised
    // by integration tests against cassettes.
    expect(client).toBeInstanceOf(WebClient);
  });
});
