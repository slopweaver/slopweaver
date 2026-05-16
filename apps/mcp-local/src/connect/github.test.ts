/**
 * Unit tests for runConnectGithub.
 *
 * The DI shape lets us pass real createDb (in-memory) plus fake prompt and
 * fake validator; no `vi.mock` needed. Asserts the three contracts the plan
 * pins: happy path persists the token, invalid token does NOT persist, and
 * repeat connect overwrites the previous value.
 */

import { createDb, loadIntegrationToken } from '@slopweaver/db';
import { errAsync, okAsync } from '@slopweaver/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runConnectGithub } from './github.ts';

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

describe('runConnectGithub', () => {
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

  it('happy path: validates, persists, prints the login', async () => {
    const code = await runConnectGithub({
      db: handle.db,
      promptForToken: async () => 'ghp_happy',
      validateToken: ({ token }) => {
        expect(token).toBe('ghp_happy');
        return okAsync({ login: 'octocat' });
      },
      stdout,
      stderr,
      now: () => 1_746_000_000_000,
    });

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Connected to GitHub as octocat');
    expect(stderr.text()).toBe('');
    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toEqual({ token: 'ghp_happy', accountLabel: 'octocat' });
    }
  });

  it('invalid token: prints the error, exits 1, does NOT persist', async () => {
    const code = await runConnectGithub({
      db: handle.db,
      promptForToken: async () => 'ghp_bogus',
      validateToken: () =>
        errAsync({
          code: 'GITHUB_API_ERROR',
          message: 'Bad credentials',
        }),
      stdout,
      stderr,
    });

    expect(code).toBe(1);
    expect(stderr.text()).toContain('GitHub token rejected');
    expect(stderr.text()).toContain('Bad credentials');
    expect(stdout.text()).toBe('');
    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toBeNull();
    }
  });

  it('repeat connect overwrites the previous value with one row total', async () => {
    await runConnectGithub({
      db: handle.db,
      promptForToken: async () => 'ghp_first',
      validateToken: () => okAsync({ login: 'octocat' }),
      stdout,
      stderr,
      now: () => 1_746_000_000_000,
    });

    await runConnectGithub({
      db: handle.db,
      promptForToken: async () => 'ghp_second',
      validateToken: () => okAsync({ login: 'octocat-renamed' }),
      stdout,
      stderr,
      now: () => 1_746_000_000_500,
    });

    const loaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    expect(loaded.isOk()).toBe(true);
    if (loaded.isOk()) {
      expect(loaded.value).toEqual({ token: 'ghp_second', accountLabel: 'octocat-renamed' });
    }
  });
});
