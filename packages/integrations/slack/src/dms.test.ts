/**
 * Tests for pollDMs.
 *
 * Covers the `slack.paginate` flow for both `conversations.list` and
 * `conversations.history`, the `oldest` cursor pass-through, multi-page
 * aggregation, integration_state writes, and idempotent re-poll.
 */

import type { WebClient } from '@slack/web-api';
import { evidenceLog, integrationState } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pollDMs } from './dms.ts';
import { openMemoryDb } from './test/db.ts';

type DbHandle = ReturnType<typeof openMemoryDb>;

function asyncIter<T>(items: T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const item of items) yield item;
    },
  };
}

describe('pollDMs', () => {
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = openMemoryDb();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('lists IMs, fetches history per channel via paginate, and writes each message as kind=message', async () => {
    const client = {
      auth: {
        test: async () => ({
          ok: true,
          user_id: 'U0SLOPBOT',
          user: 'slopbot',
          team_id: 'T0WORKSPACE',
          url: 'https://slopweaver.slack.com/',
        }),
      },
      paginate: (method: string, opts: Record<string, unknown>) => {
        if (method === 'conversations.list') {
          return asyncIter([
            {
              ok: true,
              channels: [
                { id: 'D0ALICE', user: 'U0ALICE', is_im: true },
                { id: 'D0BOB', user: 'U0BOB', is_im: true },
              ],
            },
          ]);
        }
        if (method === 'conversations.history') {
          const channel = opts['channel'] as string;
          if (channel === 'D0ALICE') {
            return asyncIter([
              {
                ok: true,
                messages: [{ ts: '1762000010.000000', user: 'U0ALICE', text: 'hi from alice' }],
              },
            ]);
          }
          if (channel === 'D0BOB') {
            return asyncIter([
              {
                ok: true,
                messages: [
                  { ts: '1762000020.000000', user: 'U0BOB', text: 'hi from bob' },
                  { ts: '1762000021.000000', user: 'U0BOB', text: 'second message' },
                ],
              },
            ]);
          }
        }
        throw new Error(`unexpected paginate method: ${method}`);
      },
    } as unknown as WebClient;

    const result = await pollDMs({
      db: dbHandle.db,
      token: 'xoxb-test',
      client,
      now: () => 8_888,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error('unreachable');
    const value = result.value;

    expect(value.fetched).toBe(3);
    expect(value.newCursor).toBe(new Date(1_762_000_021_000).toISOString());

    const rows = dbHandle.db.select().from(evidenceLog).all();
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.kind === 'message')).toBe(true);
    expect([...rows.map((r) => r.externalId)].sort()).toEqual([
      'message_1762000010.000000:D0ALICE',
      'message_1762000020.000000:D0BOB',
      'message_1762000021.000000:D0BOB',
    ]);
  });

  it('writes integration_state with started < completed and cursor at newest ts', async () => {
    let nowCounter = 1000;
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      paginate: (method: string) => {
        if (method === 'conversations.list') {
          return asyncIter([{ ok: true, channels: [{ id: 'D1', user: 'U2', is_im: true }] }]);
        }
        if (method === 'conversations.history') {
          return asyncIter([{ ok: true, messages: [{ ts: '7.0', user: 'U2', text: 'hello' }] }]);
        }
        throw new Error('unexpected');
      },
    } as unknown as WebClient;

    const result = await pollDMs({
      db: dbHandle.db,
      token: 'xoxb-test',
      client,
      now: () => nowCounter++,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error('unreachable');
    const value = result.value;

    expect(value.newCursor).toBe(new Date(7_000).toISOString());

    const state = dbHandle.db.select().from(integrationState).all();
    expect(state).toHaveLength(1);
    expect(state[0]?.integration).toBe('slack');
    expect(state[0]?.lastPollStartedAtMs).toBeLessThan(state[0]?.lastPollCompletedAtMs ?? 0);
    expect(state[0]?.cursor).toBe(new Date(7_000).toISOString());
  });

  it('preserves prior cursor when the poll observes zero messages', async () => {
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      paginate: (method: string) => {
        if (method === 'conversations.list') {
          return asyncIter([{ ok: true, channels: [{ id: 'D1', user: 'U2', is_im: true }] }]);
        }
        if (method === 'conversations.history') {
          return asyncIter([{ ok: true, messages: [] }]);
        }
        throw new Error('unexpected');
      },
    } as unknown as WebClient;

    const result = await pollDMs({
      db: dbHandle.db,
      token: 'xoxb-test',
      client,
      since: new Date('2026-05-01T00:00:00Z'),
      now: () => 1,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error('unreachable');
    const value = result.value;

    expect(value.newCursor).toBe('2026-05-01T00:00:00.000Z');
  });

  it('aggregates messages across multiple history pages for one channel', async () => {
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      paginate: (method: string) => {
        if (method === 'conversations.list') {
          return asyncIter([{ ok: true, channels: [{ id: 'D1', user: 'U2', is_im: true }] }]);
        }
        if (method === 'conversations.history') {
          return asyncIter([
            { ok: true, messages: [{ ts: '1.0', user: 'U2', text: 'page1-msg1' }] },
            { ok: true, messages: [{ ts: '2.0', user: 'U2', text: 'page2-msg1' }] },
            { ok: true, messages: [{ ts: '3.0', user: 'U2', text: 'page3-msg1' }] },
          ]);
        }
        throw new Error('unexpected');
      },
    } as unknown as WebClient;

    const result = await pollDMs({
      db: dbHandle.db,
      token: 'xoxb-test',
      client,
      now: () => 1,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error('unreachable');
    const value = result.value;

    expect(value.fetched).toBe(3);
    expect(value.newCursor).toBe(new Date(3_000).toISOString());
    expect(dbHandle.db.select().from(evidenceLog).all()).toHaveLength(3);
  });

  it('passes the since timestamp through as the `oldest` cursor on history calls', async () => {
    const historySeen: Record<string, unknown>[] = [];
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      paginate: (method: string, opts: Record<string, unknown>) => {
        if (method === 'conversations.list') {
          return asyncIter([{ ok: true, channels: [{ id: 'D1', user: 'U2', is_im: true }] }]);
        }
        if (method === 'conversations.history') {
          historySeen.push(opts);
          return asyncIter([{ ok: true, messages: [] }]);
        }
        throw new Error('unexpected');
      },
    } as unknown as WebClient;

    const result = await pollDMs({
      db: dbHandle.db,
      token: 'xoxb-test',
      client,
      since: new Date('2026-05-01T00:00:00Z'),
      now: () => 1,
    });
    expect(result.isOk()).toBe(true);

    expect(historySeen).toHaveLength(1);
    expect(historySeen[0]).toMatchObject({
      channel: 'D1',
      // 2026-05-01T00:00:00Z = 1777593600 unix seconds
      oldest: '1777593600.000000',
    });
  });

  it('treats a re-poll of the same DM history as an update, not an insert', async () => {
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      paginate: (method: string) => {
        if (method === 'conversations.list') {
          return asyncIter([{ ok: true, channels: [{ id: 'D1', user: 'U2', is_im: true }] }]);
        }
        if (method === 'conversations.history') {
          return asyncIter([{ ok: true, messages: [{ ts: '1.0', user: 'U2', text: 'hello' }] }]);
        }
        throw new Error('unexpected');
      },
    } as unknown as WebClient;

    const r1 = await pollDMs({ db: dbHandle.db, token: 'xoxb-test', client, now: () => 100 });
    expect(r1.isOk()).toBe(true);
    const r2 = await pollDMs({ db: dbHandle.db, token: 'xoxb-test', client, now: () => 200 });
    expect(r2.isOk()).toBe(true);

    expect(dbHandle.db.select().from(evidenceLog).all()).toHaveLength(1);
  });
});

describe('pollDMs (cassette)', () => {
  // Smoke test against a recorded cassette. Scrubbed at record-time:
  // message text, channel names, and the workspace URL are all redacted.
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = openMemoryDb();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('returns a fetched count and writes integration_state for slack', async () => {
    const result = await pollDMs({
      db: dbHandle.db,
      token: process.env['SLACK_USER_TOKEN'] ?? 'xoxp-replay-token',
      now: () => 1_000,
    });
    expect(result.isOk()).toBe(true);
    if (result.isErr()) throw new Error('unreachable');
    const value = result.value;

    expect(typeof value.fetched).toBe('number');
    expect(value.fetched).toBeGreaterThanOrEqual(0);

    const state = dbHandle.db.select().from(integrationState).all();
    expect(state).toHaveLength(1);
    expect(state[0]?.integration).toBe('slack');
    expect(state[0]?.lastPollStartedAtMs).toBeLessThanOrEqual(state[0]?.lastPollCompletedAtMs ?? 0);

    const rows = dbHandle.db.select().from(evidenceLog).all();
    for (const row of rows) {
      expect(row.kind).toBe('message');
      expect(row.externalId).toMatch(/^message_\d+\.\d+:[CDG][A-Z0-9]+$/);
    }
  });
});
