/**
 * Tests for createGithubPoller.
 *
 * The adapter is a thin wiring layer: read cursor from integration_state, call
 * each underlying poll function sequentially with that cursor as `since`,
 * surface failure via `_unsafeUnwrap` so the closure's `Promise<void>`
 * contract rejects on `Err`.
 *
 * We `vi.mock` the underlying `./polling.ts` exports so the tests verify the
 * adapter's wiring without recording fresh cassettes — the cassette-backed
 * integration is already covered by `polling.test.ts`. Each test asserts:
 *   1. Each sub-poll is called in the right order.
 *   2. `since` is threaded from the seeded `integration_state.cursor`.
 *   3. `token` and `username` are threaded into the right calls.
 *   4. `now` is threaded as a function returning the contract's `now: number`.
 *   5. An `Err` from any sub-poll rejects the closure's promise.
 */

import { createDb, integrationState } from '@slopweaver/db';
import { errAsync, okAsync } from '@slopweaver/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GithubErrors } from './errors.ts';
import { pollIssues, pollMentions, pollPullRequests } from './polling.ts';
import { createGithubPoller } from './poller.ts';

vi.mock('./polling.ts', () => ({
  pollPullRequests: vi.fn(),
  pollIssues: vi.fn(),
  pollMentions: vi.fn(),
}));

const mockedPollPullRequests = vi.mocked(pollPullRequests);
const mockedPollIssues = vi.mocked(pollIssues);
const mockedPollMentions = vi.mocked(pollMentions);

type DbHandle = ReturnType<typeof createDb>;

const NOW_MS = 1_762_500_000_000;

function stubAllOk(): void {
  mockedPollPullRequests.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
  mockedPollIssues.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
  mockedPollMentions.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
}

describe('createGithubPoller', () => {
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    mockedPollPullRequests.mockReset();
    mockedPollIssues.mockReset();
    mockedPollMentions.mockReset();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('returns a callable poller; invoking it runs all three sub-polls in order', async () => {
    stubAllOk();

    const poller = createGithubPoller({ token: 'ghp_test_token', username: 'lachiejames' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    expect(mockedPollPullRequests).toHaveBeenCalledTimes(1);
    expect(mockedPollIssues).toHaveBeenCalledTimes(1);
    expect(mockedPollMentions).toHaveBeenCalledTimes(1);

    const prOrder = mockedPollPullRequests.mock.invocationCallOrder[0] ?? 0;
    const issueOrder = mockedPollIssues.mock.invocationCallOrder[0] ?? 0;
    const mentionOrder = mockedPollMentions.mock.invocationCallOrder[0] ?? 0;
    expect(prOrder).toBeLessThan(issueOrder);
    expect(issueOrder).toBeLessThan(mentionOrder);
  });

  it('threads token, db, and now (as a function) into every sub-poll', async () => {
    stubAllOk();

    const poller = createGithubPoller({ token: 'ghp_thread_test', username: 'lachiejames' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    for (const spy of [mockedPollPullRequests, mockedPollIssues, mockedPollMentions]) {
      const call = spy.mock.calls[0]?.[0];
      expect(call?.token).toBe('ghp_thread_test');
      expect(call?.db).toBe(dbHandle.db);
      expect(typeof call?.now).toBe('function');
      expect(call?.now?.()).toBe(NOW_MS);
    }
  });

  it('threads the username into pollMentions only', async () => {
    stubAllOk();

    const poller = createGithubPoller({ token: 'ghp_test', username: 'octocat' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    const mentionsCall = mockedPollMentions.mock.calls[0]?.[0];
    expect(mentionsCall?.username).toBe('octocat');
  });

  it('passes a null `since` when integration_state has no cursor', async () => {
    stubAllOk();

    const poller = createGithubPoller({ token: 'ghp_test', username: 'octocat' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    for (const spy of [mockedPollPullRequests, mockedPollIssues, mockedPollMentions]) {
      expect(spy.mock.calls[0]?.[0]?.since).toBeNull();
    }
  });

  it('reads integration_state.cursor and threads it as a Date `since`', async () => {
    stubAllOk();
    dbHandle.db
      .insert(integrationState)
      .values({
        integration: 'github',
        cursor: '2026-05-01T00:00:00.000Z',
        lastPollStartedAtMs: 0,
        lastPollCompletedAtMs: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
      })
      .run();

    const poller = createGithubPoller({ token: 'ghp_test', username: 'octocat' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    for (const spy of [mockedPollPullRequests, mockedPollIssues, mockedPollMentions]) {
      const since = spy.mock.calls[0]?.[0]?.since;
      expect(since).toBeInstanceOf(Date);
      expect(since?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    }
  });

  it('rejects the closure promise when pollPullRequests returns Err (and skips later sub-polls)', async () => {
    mockedPollPullRequests.mockReturnValue(
      errAsync(GithubErrors.apiError('search.issuesAndPullRequests', { status: 401 })),
    );
    mockedPollIssues.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
    mockedPollMentions.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));

    const poller = createGithubPoller({ token: 'ghp_test', username: 'octocat' });
    // `_unsafeUnwrap` on an Err rejects with a neverthrow wrapper that
    // carries the original Result on `.data` — the BaseError lives at
    // `data.value`. We assert via the wrapper shape directly rather than
    // unwrap it; the wrapper IS the boundary translation, and a future
    // contract change would surface here.
    await expect(poller({ db: dbHandle.db, now: NOW_MS })).rejects.toMatchObject({
      data: { type: 'Err', value: { code: 'GITHUB_API_ERROR', status: 401 } },
    });

    expect(mockedPollPullRequests).toHaveBeenCalledTimes(1);
    expect(mockedPollIssues).not.toHaveBeenCalled();
    expect(mockedPollMentions).not.toHaveBeenCalled();
  });

  it('rejects when pollMentions (the last sub-poll) returns Err', async () => {
    mockedPollPullRequests.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
    mockedPollIssues.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
    mockedPollMentions.mockReturnValue(
      errAsync(GithubErrors.apiError('search.issuesAndPullRequests', { status: 422 })),
    );

    const poller = createGithubPoller({ token: 'ghp_test', username: 'octocat' });
    await expect(poller({ db: dbHandle.db, now: NOW_MS })).rejects.toMatchObject({
      data: { type: 'Err', value: { code: 'GITHUB_API_ERROR', status: 422 } },
    });

    expect(mockedPollPullRequests).toHaveBeenCalledTimes(1);
    expect(mockedPollIssues).toHaveBeenCalledTimes(1);
    expect(mockedPollMentions).toHaveBeenCalledTimes(1);
  });
});
