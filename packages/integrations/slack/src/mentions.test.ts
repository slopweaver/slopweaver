/**
 * Tests for pollMentions.
 *
 * The SlackClient is a `WebClient` partial mock — Phase 6 swaps these for
 * real cassettes. Tests cover: search query construction, evidence_log row
 * shape (including the kind-prefixed external_id), idempotent re-poll,
 * graceful skipping, page-based pagination, and integration_state writes.
 */

import type { WebClient } from '@slack/web-api';
import { evidenceLog, integrationState } from '@slopweaver/db';
import type { ResultAsync } from '@slopweaver/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SlackError } from './errors.ts';
import { pollMentions, type PollResult } from './mentions.ts';
import { openMemoryDb } from './test/db.ts';

type DbHandle = ReturnType<typeof openMemoryDb>;

/**
 * Unwrap a `ResultAsync` known to be Ok in this test, with a strong
 * assertion. Equivalent to `expect(r.isOk()).toBe(true); return r.value`.
 */
function expectOkValue(promise: ResultAsync<PollResult, SlackError>): Promise<PollResult> {
  return promise.match(
    (v) => {
      expect(true).toBe(true);
      return v;
    },
    (e) => {
      throw new Error(`expectOkValue: result was Err: ${e.code} (${e.message})`);
    },
  );
}

describe('pollMentions', () => {
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = openMemoryDb();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it("queries search.messages with the auth'd user mention and writes one row per match", async () => {
    const searchSpy = vi.fn(async (args: { query: string; count: number; page?: number }) => {
      expect(args).toMatchObject({ query: '<@U0SLOPBOT>', count: 100 });
      return {
        ok: true,
        messages: {
          matches: [
            {
              ts: '1762000000.000100',
              user: 'U0ALICE',
              text: 'hey <@U0SLOPBOT> can you check this?',
              channel: { id: 'C0DESIGN', name: 'design' },
            },
            {
              ts: '1762000000.000200',
              user: 'U0BOB',
              text: 'cc <@U0SLOPBOT>',
              channel: { id: 'C0ENG' },
              permalink: 'https://slopweaver.slack.com/archives/C0ENG/p1762000000000200',
            },
          ],
          paging: { count: 2, total: 2, page: 1, pages: 1 },
        },
      };
    });
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
      search: { messages: searchSpy },
    } as unknown as WebClient;

    const value = await expectOkValue(
      pollMentions({
        db: dbHandle.db,
        token: 'xoxp-test',
        client,
        now: () => 9_000_000,
      }),
    );

    expect(value.fetched).toBe(2);
    // Cursor normalized to ISO-8601 from the newest match's ts. The `.000200`
    // tail is microseconds, which round to 0 ms below epoch-ms granularity.
    expect(value.newCursor).toBe(new Date(1_762_000_000_000).toISOString());
    expect(searchSpy).toHaveBeenCalledOnce();

    const rows = dbHandle.db.select().from(evidenceLog).all();
    expect(rows).toHaveLength(2);

    const designRow = rows.find((r) => r.externalId === 'mention_1762000000.000100:C0DESIGN');
    expect(designRow).toMatchObject({
      integration: 'slack',
      kind: 'mention',
      title: 'hey <@U0SLOPBOT> can you check this?',
      body: 'hey <@U0SLOPBOT> can you check this?',
      citationUrl: 'https://slopweaver.slack.com/archives/C0DESIGN/p1762000000000100',
      occurredAtMs: 1_762_000_000_000,
      firstSeenAtMs: 9_000_000,
      lastSeenAtMs: 9_000_000,
    });

    const engRow = rows.find((r) => r.externalId === 'mention_1762000000.000200:C0ENG');
    expect(engRow?.citationUrl).toBe(
      'https://slopweaver.slack.com/archives/C0ENG/p1762000000000200',
    );
    expect(engRow?.payloadJson).toContain('"_team_id":"T0WORKSPACE"');
  });

  it('writes integration_state with started < completed and cursor at newest ts', async () => {
    let nowCounter = 1000;
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      search: {
        messages: async () => ({
          ok: true,
          messages: {
            matches: [{ ts: '500.0', text: 'hi', user: 'U2', channel: { id: 'C1' } }],
            paging: { count: 1, total: 1, page: 1, pages: 1 },
          },
        }),
      },
    } as unknown as WebClient;

    const value = await expectOkValue(
      pollMentions({
        db: dbHandle.db,
        token: 'xoxp-test',
        client,
        now: () => nowCounter++,
      }),
    );

    expect(value.newCursor).toBe(new Date(500_000).toISOString());

    const state = dbHandle.db.select().from(integrationState).all();
    expect(state).toHaveLength(1);
    expect(state[0]?.integration).toBe('slack');
    expect(state[0]?.lastPollStartedAtMs).toBeLessThan(state[0]?.lastPollCompletedAtMs ?? 0);
    expect(state[0]?.cursor).toBe(new Date(500_000).toISOString());
  });

  it('preserves prior cursor when the poll returns zero matches', async () => {
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      search: {
        messages: async () => ({
          ok: true,
          messages: { matches: [], paging: { count: 0, total: 0, page: 1, pages: 1 } },
        }),
      },
    } as unknown as WebClient;

    const value = await expectOkValue(
      pollMentions({
        db: dbHandle.db,
        token: 'xoxp-test',
        client,
        since: new Date('2026-05-01T00:00:00Z'),
        now: () => 1,
      }),
    );

    // The since fallback is the ISO date, since no matches yielded a ts.
    expect(value.newCursor).toBe('2026-05-01T00:00:00.000Z');
    expect(value.fetched).toBe(0);
  });

  it('appends a 1-day-padded after: filter when since is provided', async () => {
    const searchSpy = vi.fn(async (args: { query: string }) => {
      // 2026-05-01T12:00:00Z padded backward 1 day = 2026-04-30
      expect(args.query).toBe('<@U1> after:2026-04-30');
      return {
        ok: true,
        messages: { matches: [], paging: { count: 0, total: 0, page: 1, pages: 1 } },
      };
    });
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      search: { messages: searchSpy },
    } as unknown as WebClient;

    await expectOkValue(
      pollMentions({
        db: dbHandle.db,
        token: 'xoxp-test',
        client,
        since: new Date('2026-05-01T12:00:00Z'),
        now: () => 1,
      }),
    );
  });

  it('walks search.messages pages until messages.paging.pages is reached', async () => {
    const seenPages: number[] = [];
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      search: {
        messages: async (args: { page?: number }) => {
          const page = args.page ?? 1;
          seenPages.push(page);
          return {
            ok: true,
            messages: {
              matches: [
                {
                  ts: `${1_000_000 + page}.000000`,
                  user: 'U2',
                  text: `page ${page}`,
                  channel: { id: 'C1' },
                },
              ],
              paging: { count: 1, total: 3, page, pages: 3 },
            },
          };
        },
      },
    } as unknown as WebClient;

    const value = await expectOkValue(
      pollMentions({
        db: dbHandle.db,
        token: 'xoxp-test',
        client,
        now: () => 1,
      }),
    );

    expect(seenPages).toEqual([1, 2, 3]);
    expect(value.fetched).toBe(3);
    // Newest ts = 1000003.000000 = 1000003000 ms.
    expect(value.newCursor).toBe(new Date(1_000_003_000).toISOString());
    expect(dbHandle.db.select().from(evidenceLog).all()).toHaveLength(3);
  });

  it('returns SLACK_PAGINATION_CAP_EXCEEDED without advancing the cursor when paging exceeds MAX_PAGES', async () => {
    // Pre-seed integration_state with a baseline cursor so we can prove it
    // wasn't advanced by the failed poll.
    dbHandle.db
      .insert(integrationState)
      .values({
        integration: 'slack',
        cursor: 'baseline-cursor-value',
        lastPollStartedAtMs: 0,
        lastPollCompletedAtMs: 0,
        createdAtMs: 0,
        updatedAtMs: 0,
      })
      .run();

    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      search: {
        messages: async () => ({
          ok: true,
          messages: {
            matches: [{ ts: '1.0', text: 'm', user: 'U2', channel: { id: 'C1' } }],
            // Slack reports 21 total pages — over the 20-page safety cap.
            paging: { count: 1, total: 21, page: 1, pages: 21 },
          },
        }),
      },
    } as unknown as WebClient;

    const result = await pollMentions({
      db: dbHandle.db,
      token: 'xoxp-test',
      client,
      now: () => 1,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('SLACK_PAGINATION_CAP_EXCEEDED');
    }

    // Cursor must still be the baseline — markPollCompleted never ran.
    const state = dbHandle.db.select().from(integrationState).get();
    expect(state?.cursor).toBe('baseline-cursor-value');
    expect(state?.lastPollCompletedAtMs).toBe(0);
  });

  it('is idempotent on re-poll: same ts:channel updates rather than duplicating', async () => {
    const match = {
      ts: '1762000000.000100',
      user: 'U0ALICE',
      text: 'hi <@U1>',
      channel: { id: 'C0X' },
    };
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      search: {
        messages: async () => ({
          ok: true,
          messages: { matches: [match], paging: { count: 1, total: 1, page: 1, pages: 1 } },
        }),
      },
    } as unknown as WebClient;

    await expectOkValue(
      pollMentions({ db: dbHandle.db, token: 'xoxp-test', client, now: () => 100 }),
    );
    await expectOkValue(
      pollMentions({ db: dbHandle.db, token: 'xoxp-test', client, now: () => 200 }),
    );

    const rows = dbHandle.db.select().from(evidenceLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      firstSeenAtMs: 100,
      lastSeenAtMs: 200,
      createdAtMs: 100,
      updatedAtMs: 200,
    });
  });

  it.skip('cassette: real workspace happy path — see pollMentions (cassette) describe block', () => {
    // Placeholder so this comment is searchable next to the other tests.
  });

  it('skips messages without a channel rather than failing the whole poll', async () => {
    const client = {
      auth: { test: async () => ({ ok: true, user_id: 'U1', user: 'a', team_id: 'T1' }) },
      search: {
        messages: async () => ({
          ok: true,
          messages: {
            matches: [
              { ts: '100.0', text: 'no channel', user: 'U2' },
              { ts: '101.0', text: 'has channel', user: 'U2', channel: { id: 'C1' } },
            ],
            paging: { count: 2, total: 2, page: 1, pages: 1 },
          },
        }),
      },
    } as unknown as WebClient;

    const value = await expectOkValue(
      pollMentions({
        db: dbHandle.db,
        token: 'xoxp-test',
        client,
        now: () => 1,
      }),
    );

    expect(value.fetched).toBe(2); // counts what Slack returned, not what got upserted
    const rows = dbHandle.db.select().from(evidenceLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.externalId).toBe('mention_101.0:C1');
  });
});

describe('pollMentions (cassette)', () => {
  // Smoke test against a recorded cassette of a real workspace's response.
  // The cassette was scrubbed by src/test/redact-slack.ts at record-time —
  // message text, channel names, and the workspace URL are all redacted —
  // so assertions only check structural shape.
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = openMemoryDb();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('returns a fetched count and writes integration_state for slack', async () => {
    const value = await expectOkValue(
      pollMentions({
        db: dbHandle.db,
        token: process.env['SLACK_USER_TOKEN'] ?? 'xoxp-replay-token',
        now: () => 1_000,
      }),
    );

    expect(typeof value.fetched).toBe('number');
    expect(value.fetched).toBeGreaterThanOrEqual(0);

    const state = dbHandle.db.select().from(integrationState).all();
    expect(state).toHaveLength(1);
    expect(state[0]?.integration).toBe('slack');
    expect(state[0]?.lastPollStartedAtMs).toBeLessThanOrEqual(state[0]?.lastPollCompletedAtMs ?? 0);

    // If any rows landed, they must be kind='mention' with a kind-prefixed
    // external_id keying on a Slack ts:channel. The redactor preserves IDs.
    const rows = dbHandle.db.select().from(evidenceLog).all();
    for (const row of rows) {
      expect(row.kind).toBe('mention');
      expect(row.externalId).toMatch(/^mention_\d+\.\d+:[CDG][A-Z0-9]+$/);
    }
  });
});
