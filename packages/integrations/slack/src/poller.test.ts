/**
 * Tests for createSlackPoller.
 *
 * The adapter is a thin wiring layer: read cursor from integration_state,
 * call `pollMentions` then `pollDMs` sequentially with that cursor as `since`,
 * surface failure via `_unsafeUnwrap` so the closure's `Promise<void>`
 * contract rejects on `Err`.
 *
 * We `vi.mock` the underlying `./mentions.ts` and `./dms.ts` exports so the
 * tests verify the adapter's wiring without recording fresh cassettes — the
 * cassette-backed integration is already covered by `mentions.test.ts` and
 * `dms.test.ts`. Each test asserts:
 *   1. Each sub-poll is called in the right order.
 *   2. `since` is threaded from the seeded `integration_state.cursor`.
 *   3. `token` is threaded into the right calls.
 *   4. `now` is threaded as a function returning the contract's `now: number`.
 *   5. An `Err` from either sub-poll rejects the closure's promise.
 */

import { integrationState } from '@slopweaver/db';
import { errAsync, okAsync } from '@slopweaver/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pollDMs } from './dms.ts';
import { SlackErrors } from './errors.ts';
import { pollMentions } from './mentions.ts';
import { createSlackPoller } from './poller.ts';
import { openMemoryDb } from './test/db.ts';

vi.mock('./mentions.ts', () => ({
  pollMentions: vi.fn(),
}));
vi.mock('./dms.ts', () => ({
  pollDMs: vi.fn(),
}));

const mockedPollMentions = vi.mocked(pollMentions);
const mockedPollDMs = vi.mocked(pollDMs);

type DbHandle = ReturnType<typeof openMemoryDb>;

const NOW_MS = 1_762_500_000_000;

function stubAllOk(): void {
  mockedPollMentions.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
  mockedPollDMs.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
}

describe('createSlackPoller', () => {
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = openMemoryDb();
    mockedPollMentions.mockReset();
    mockedPollDMs.mockReset();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('returns a callable poller; invoking it runs both sub-polls in order (mentions then DMs)', async () => {
    stubAllOk();

    const poller = createSlackPoller({ token: 'xoxp-test-token' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    expect(mockedPollMentions).toHaveBeenCalledTimes(1);
    expect(mockedPollDMs).toHaveBeenCalledTimes(1);

    const mentionsOrder = mockedPollMentions.mock.invocationCallOrder[0] ?? 0;
    const dmsOrder = mockedPollDMs.mock.invocationCallOrder[0] ?? 0;
    expect(mentionsOrder).toBeLessThan(dmsOrder);
  });

  it('threads token, db, and now (as a function) into both sub-polls', async () => {
    stubAllOk();

    const poller = createSlackPoller({ token: 'xoxp-thread-test' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    for (const spy of [mockedPollMentions, mockedPollDMs]) {
      const call = spy.mock.calls[0]?.[0];
      expect(call?.token).toBe('xoxp-thread-test');
      expect(call?.db).toBe(dbHandle.db);
      expect(typeof call?.now).toBe('function');
      expect(call?.now?.()).toBe(NOW_MS);
    }
  });

  it('passes an undefined `since` when integration_state has no cursor', async () => {
    stubAllOk();

    const poller = createSlackPoller({ token: 'xoxp-test' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    for (const spy of [mockedPollMentions, mockedPollDMs]) {
      expect(spy.mock.calls[0]?.[0]?.since).toBeUndefined();
    }
  });

  it('reads integration_state.cursor and threads it as a Date `since`', async () => {
    stubAllOk();
    dbHandle.db
      .insert(integrationState)
      .values({
        integration: 'slack',
        cursor: '2026-05-01T00:00:00.000Z',
        lastPollStartedAtMs: 0,
        lastPollCompletedAtMs: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
      })
      .run();

    const poller = createSlackPoller({ token: 'xoxp-test' });
    await poller({ db: dbHandle.db, now: NOW_MS });

    for (const spy of [mockedPollMentions, mockedPollDMs]) {
      const since = spy.mock.calls[0]?.[0]?.since;
      expect(since).toBeInstanceOf(Date);
      expect(since?.toISOString()).toBe('2026-05-01T00:00:00.000Z');
    }
  });

  it('rejects the closure promise when pollMentions returns Err (and skips pollDMs)', async () => {
    mockedPollMentions.mockReturnValue(
      errAsync(SlackErrors.apiError('search.messages', { slackCode: 'not_allowed_token_type' })),
    );
    mockedPollDMs.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));

    const poller = createSlackPoller({ token: 'xoxb-bot-token' });
    // `_unsafeUnwrap` on an Err rejects with a neverthrow wrapper that
    // carries the original Result on `.data` — the BaseError lives at
    // `data.value`. We assert via the wrapper shape directly rather than
    // unwrap it; the wrapper IS the boundary translation, and a future
    // contract change would surface here.
    await expect(poller({ db: dbHandle.db, now: NOW_MS })).rejects.toMatchObject({
      data: {
        type: 'Err',
        value: { code: 'SLACK_API_ERROR', slackCode: 'not_allowed_token_type' },
      },
    });

    expect(mockedPollMentions).toHaveBeenCalledTimes(1);
    expect(mockedPollDMs).not.toHaveBeenCalled();
  });

  it('rejects when pollDMs (the last sub-poll) returns Err', async () => {
    mockedPollMentions.mockReturnValue(okAsync({ fetched: 0, newCursor: null }));
    mockedPollDMs.mockReturnValue(
      errAsync(SlackErrors.apiError('conversations.list', { status: 429 })),
    );

    const poller = createSlackPoller({ token: 'xoxp-test' });
    await expect(poller({ db: dbHandle.db, now: NOW_MS })).rejects.toMatchObject({
      data: { type: 'Err', value: { code: 'SLACK_API_ERROR', status: 429 } },
    });

    expect(mockedPollMentions).toHaveBeenCalledTimes(1);
    expect(mockedPollDMs).toHaveBeenCalledTimes(1);
  });
});
