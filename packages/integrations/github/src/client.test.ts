import { describe, expect, it } from 'vitest';
import { createGithubClient, extractGithubError } from './client.ts';

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

  it('throws an error with status on 401', async () => {
    const octokit = createGithubClient({ token: 'ghp_invalid_token_for_recording' });
    const err = await octokit.rest.users.getAuthenticated().catch((e: unknown) => e);
    const shape = extractGithubError({ error: err });
    expect(shape.statusCode).toBe(401);
    expect(shape.responseBody).toMatchObject({ message: expect.any(String) });
  });
});

describe('extractGithubError', () => {
  it('returns {} for non-objects', () => {
    expect(extractGithubError({ error: 'oops' })).toEqual({});
    expect(extractGithubError({ error: null })).toEqual({});
    expect(extractGithubError({ error: 42 })).toEqual({});
  });

  it('extracts status + response.data from Octokit-shaped errors', () => {
    const err = { status: 404, response: { data: { message: 'Not Found' } } };
    expect(extractGithubError({ error: err })).toEqual({
      statusCode: 404,
      responseBody: { message: 'Not Found' },
    });
  });

  it('omits fields that are not present', () => {
    expect(extractGithubError({ error: { status: 500 } })).toEqual({ statusCode: 500 });
    expect(extractGithubError({ error: { response: { data: { x: 1 } } } })).toEqual({
      responseBody: { x: 1 },
    });
  });
});
