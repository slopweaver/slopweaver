import { RequestError } from '@octokit/request-error';
import { describe, expect, it } from 'vitest';
import { createGithubClient } from './client.ts';

const REPLAY_TOKEN = process.env['GH_TOKEN'] ?? 'ghp_replay_token_redacted';

describe('createGithubClient', () => {
  it('returns parsed user data on 200', async () => {
    const octokit = createGithubClient({ token: REPLAY_TOKEN });
    const res = await octokit.rest.users.getAuthenticated();
    expect(res.status).toBe(200);
    // Mode-agnostic: in replay the cassette has `test-user`/`id: 1` (see
    // test-setup/polly.ts redaction); in record we see the real account.
    // Both modes guarantee the response shape — that's all this test asserts.
    expect(typeof res.data.login).toBe('string');
    expect(res.data.login.length).toBeGreaterThan(0);
    expect(typeof res.data.id).toBe('number');
  });

  it('throws RequestError with status + response data on 401', async () => {
    const octokit = createGithubClient({ token: 'ghp_invalid_token_for_recording' });
    const error = await octokit.rest.users.getAuthenticated().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RequestError);
    if (error instanceof RequestError) {
      expect(error.status).toBe(401);
      expect(error.response?.data).toMatchObject({ message: expect.any(String) });
    }
  });
});
