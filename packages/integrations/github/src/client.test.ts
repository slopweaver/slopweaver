import { describe, expect, it, vi } from 'vitest';
import { GithubFetchError, githubFetch } from './client.ts';

const REPLAY_TOKEN = process.env['GITHUB_PAT'] ?? 'ghp_replay_token_redacted';

describe('githubFetch', () => {
  it('returns parsed JSON on 200', async () => {
    const result = await githubFetch({
      token: REPLAY_TOKEN,
      path: '/user',
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({ login: expect.any(String), id: expect.any(Number) });
  });

  it('throws GithubFetchError on 401', async () => {
    // Recording uses a deliberately invalid token so GitHub returns 401.
    // The Authorization header is redacted before the cassette is persisted.
    const error = await githubFetch({
      token: 'ghp_invalid_token_for_recording',
      path: '/user',
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GithubFetchError);
    expect((error as GithubFetchError).status).toBe(401);
  });

  it('sleeps when X-RateLimit-Remaining is below threshold', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await githubFetch({
      token: REPLAY_TOKEN,
      path: '/user',
      sleep,
      // Force the sleep branch regardless of recorded remaining value.
      rateLimitThreshold: 1_000_000,
    });
    expect(sleep).toHaveBeenCalledOnce();
    const arg = sleep.mock.calls[0]?.[0] as number;
    expect(arg).toBeGreaterThanOrEqual(0);
  });
});
