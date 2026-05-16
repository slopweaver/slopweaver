/**
 * Unit tests for runConnectSlack. Mirrors github.test.ts.
 */

import { createDb, loadIntegrationToken } from '@slopweaver/db';
import { errAsync, okAsync } from '@slopweaver/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runConnectSlack } from './slack.ts';

type Buf = { write: (s: string) => void; text: () => string };

function makeBuf(): Buf {
  const chunks: string[] = [];
  return {
    write: (s) => {
      chunks.push(s);
    },
    text: () => chunks.join(''),
  };
}

describe('runConnectSlack', () => {
  let handle: ReturnType<typeof createDb>;
  let stdout: Buf;
  let stderr: Buf;

  beforeEach(() => {
    handle = createDb({ path: ':memory:' });
    stdout = makeBuf();
    stderr = makeBuf();
  });

  afterEach(() => {
    handle.close();
  });

  it('happy path: validates, persists, prints the workspace name', async () => {
    const code = await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxp-test',
      validateToken: ({ token }) => {
        expect(token).toBe('xoxp-test');
        return okAsync({ team: 'AcmeCorp' });
      },
      stdout,
      stderr,
      now: () => 1_746_000_000_000,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Connected to Slack workspace "AcmeCorp"');
    expect(stderr.text()).toBe('');
    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toEqual({ token: 'xoxp-test', accountLabel: 'AcmeCorp' });
    }
  });

  it('happy path with no team name: persists with null label and prints generic success', async () => {
    const code = await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxp-test',
      validateToken: () => okAsync({ team: null }),
      stdout,
      stderr,
      now: () => 1_746_000_000_000,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Connected to Slack.');
    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toEqual({ token: 'xoxp-test', accountLabel: null });
    }
  });

  it('rejects xoxb- bot tokens before calling validateToken or persisting', async () => {
    let validateCalled = false;

    const code = await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxb-bot-token',
      validateToken: () => {
        validateCalled = true;
        return okAsync({ team: 'AcmeCorp' });
      },
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(validateCalled).toBe(false);
    expect(stderr.text()).toContain('user token (xoxp-) is required');
    expect(stderr.text()).toContain('search.messages');
    expect(stdout.text()).toBe('');
    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toBeNull();
    }
  });

  it('rejects unknown token prefixes (xapp-, xoxa-, garbage) with the same xoxp- guidance', async () => {
    const code = await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xapp-app-level',
      validateToken: () => okAsync({ team: 'AcmeCorp' }),
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain('user token (xoxp-) is required');
    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toBeNull();
    }
  });

  it('invalid token: prints the error, exits 1, does NOT persist', async () => {
    const code = await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxp-bogus',
      validateToken: () =>
        errAsync({
          code: 'SLACK_API_ERROR',
          message: 'invalid_auth',
        }),
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain('Slack token rejected');
    expect(stderr.text()).toContain('invalid_auth');
    expect(stdout.text()).toBe('');
    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toBeNull();
    }
  });

  it('repeat connect overwrites the previous value with one row total', async () => {
    await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxp-first',
      validateToken: () => okAsync({ team: 'AcmeCorp' }),
      stdout,
      stderr,
      now: () => 1_746_000_000_000,
    });

    await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxp-second',
      validateToken: () => okAsync({ team: 'AcmeCorp-Renamed' }),
      stdout,
      stderr,
      now: () => 1_746_000_000_500,
    });

    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toEqual({ token: 'xoxp-second', accountLabel: 'AcmeCorp-Renamed' });
    }
  });
});
