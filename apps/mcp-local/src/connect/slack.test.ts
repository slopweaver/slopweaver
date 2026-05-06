/**
 * Unit tests for runConnectSlack. Mirrors github.test.ts.
 */

import { createDb, loadIntegrationToken } from '@slopweaver/db';
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
      promptForToken: async () => 'xoxb-test',
      validateToken: async (token) => {
        expect(token).toBe('xoxb-test');
        return { team: 'AcmeCorp' };
      },
      stdout,
      stderr,
      now: () => 1_746_000_000_000,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Connected to Slack workspace "AcmeCorp"');
    expect(stderr.text()).toBe('');
    expect(loadIntegrationToken({ db: handle.db, integration: 'slack' })).toEqual({
      token: 'xoxb-test',
      accountLabel: 'AcmeCorp',
    });
  });

  it('happy path with no team name: persists with null label and prints generic success', async () => {
    const code = await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxb-test',
      validateToken: async () => ({ team: null }),
      stdout,
      stderr,
      now: () => 1_746_000_000_000,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Connected to Slack.');
    expect(loadIntegrationToken({ db: handle.db, integration: 'slack' })).toEqual({
      token: 'xoxb-test',
      accountLabel: null,
    });
  });

  it('invalid token: prints the error, exits 1, does NOT persist', async () => {
    const code = await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxb-bogus',
      validateToken: async () => {
        throw new Error('invalid_auth');
      },
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain('Slack token rejected');
    expect(stderr.text()).toContain('invalid_auth');
    expect(stdout.text()).toBe('');
    expect(loadIntegrationToken({ db: handle.db, integration: 'slack' })).toBeNull();
  });

  it('repeat connect overwrites the previous value with one row total', async () => {
    await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxb-first',
      validateToken: async () => ({ team: 'AcmeCorp' }),
      stdout,
      stderr,
      now: () => 1_746_000_000_000,
    });

    await runConnectSlack({
      db: handle.db,
      promptForToken: async () => 'xoxb-second',
      validateToken: async () => ({ team: 'AcmeCorp-Renamed' }),
      stdout,
      stderr,
      now: () => 1_746_000_000_500,
    });

    expect(loadIntegrationToken({ db: handle.db, integration: 'slack' })).toEqual({
      token: 'xoxb-second',
      accountLabel: 'AcmeCorp-Renamed',
    });
  });
});
