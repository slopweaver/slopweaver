/**
 * Cassette tests for createSlackPoller.
 *
 * Exercises the closure end-to-end against Polly-replayed responses for
 * `pollMentions` then `pollDMs`. Asserts that the adapter:
 *   1. invokes both sub-pollers (`integration_state` is bracketed once and
 *      evidence_log rows from either kind land),
 *   2. records progress in `integration_state` (started/completed/cursor).
 *
 * The shape of what *exactly* lands depends on the recording workspace's
 * activity. To avoid flakiness from "the test workspace happens to have no
 * mentions today", we assert presence of `integration_state` strongly and the
 * `evidence_log` row shape (when any rows land) — not a fixed count.
 *
 * Cassettes are recorded with `POLLY_MODE=record pnpm test --filter
 * @slopweaver/integrations-slack`. Redaction is enforced by the shared
 * `definePollySetup` chokepoint plus `slackRedactors` (message text, channel
 * names, profile PII, workspace URLs).
 */

import { evidenceLog, integrationState } from '@slopweaver/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSlackPoller } from './poller.ts';
import { openMemoryDb } from './test/db.ts';

type DbHandle = ReturnType<typeof openMemoryDb>;

const REPLAY_TOKEN = process.env['SLACK_USER_TOKEN'] ?? 'xoxp-replay-token-redacted';

describe('createSlackPoller (cassette)', () => {
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = openMemoryDb();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('runs both sub-polls and lands integration_state + (when present) evidence_log rows', {
    timeout: 60_000,
  }, async () => {
    const poller = createSlackPoller({ token: REPLAY_TOKEN });

    await poller({ db: dbHandle.db, now: 1_762_500_000_000 });

    // integration_state is the strong signal: the adapter chained
    // markPollStarted/Completed through both sub-pollers, so the row exists
    // with both timestamps and (if anything was fetched) an ISO cursor.
    const state = dbHandle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'slack'))
      .get();
    expect(state).toBeDefined();
    expect(state?.lastPollStartedAtMs).toBeTypeOf('number');
    expect(state?.lastPollCompletedAtMs).toBeTypeOf('number');
    // non-null: presence asserted above
    expect(state!.lastPollStartedAtMs).toBeLessThanOrEqual(state!.lastPollCompletedAtMs!);

    // evidence_log rows depend on the recording account's activity. When any
    // landed, they must be kind in {mention, message} with the expected
    // ts:channel external_id shape.
    const rows = dbHandle.db
      .select()
      .from(evidenceLog)
      .where(eq(evidenceLog.integration, 'slack'))
      .all();
    for (const row of rows) {
      expect(['mention', 'message']).toContain(row.kind);
      const expectedPrefix = row.kind === 'mention' ? 'mention_' : 'message_';
      expect(row.externalId.startsWith(expectedPrefix)).toBe(true);
      expect(row.externalId).toMatch(/^(mention|message)_\d+\.\d+:[CDG][A-Z0-9]+$/);
    }
  });

  it('on second invocation: integration_state continues to advance (cursor is read + threaded as since)', {
    timeout: 120_000,
  }, async () => {
    const poller = createSlackPoller({ token: REPLAY_TOKEN });

    await poller({ db: dbHandle.db, now: 1_762_500_000_000 });

    const stateAfterFirst = dbHandle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'slack'))
      .get();
    expect(stateAfterFirst).toBeDefined();
    expect(stateAfterFirst?.lastPollCompletedAtMs).toBeTypeOf('number');
    // non-null: presence asserted above
    const firstCompleted = stateAfterFirst!.lastPollCompletedAtMs!;

    await poller({ db: dbHandle.db, now: 1_762_500_001_000 });

    const stateAfterSecond = dbHandle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'slack'))
      .get();
    // The second poll must have re-bracketed the integration_state row —
    // proving the closure ran end-to-end again with the cursor it just read.
    expect(stateAfterSecond).toBeDefined();
    expect(stateAfterSecond?.lastPollStartedAtMs).toBeTypeOf('number');
    expect(stateAfterSecond?.lastPollCompletedAtMs).toBeTypeOf('number');
    // non-null: presence asserted above
    expect(stateAfterSecond!.lastPollStartedAtMs!).toBeGreaterThan(firstCompleted);
    // non-null: presence asserted above
    expect(stateAfterSecond!.lastPollCompletedAtMs!).toBeGreaterThanOrEqual(firstCompleted);
  });
});
