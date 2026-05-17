/**
 * Cassette tests for createGithubPoller.
 *
 * Exercises the closure end-to-end against Polly-replayed responses for
 * `pollPullRequests` → `pollIssues` → `pollMentions`. Asserts that the
 * adapter:
 *   1. invokes all three sub-pollers (rows land for each `kind`),
 *   2. records progress in `integration_state` (started/completed/cursor),
 *   3. threads a cursor from `integration_state` as `since` on re-poll
 *      (idempotency — same external_ids, no duplicate rows, lastSeenAtMs
 *      advances).
 *
 * Cassettes are recorded with `POLLY_MODE=record pnpm test --filter
 * @slopweaver/integrations-github`. Redaction is enforced by the shared
 * `definePollySetup` chokepoint plus the per-package `/user` redactor in
 * `src/test-setup/polly.ts`.
 *
 * Mirrors the pattern used by `polling.test.ts` — same fake replay token,
 * same in-memory DB, same `now` injection through the closure contract.
 */

import { createDb, evidenceLog, integrationState } from '@slopweaver/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGithubPoller } from './poller.ts';

const REPLAY_TOKEN = process.env['GH_TOKEN'] ?? 'ghp_replay_token_redacted';

// GitHub's `mentions:` qualifier rejects `@me`, so the cassette URLs bake in
// the maintainer's public login. Logins are public information and the
// existing polling.test.ts uses the same constant.
const RECORDING_USERNAME = 'lachiejames';

type DbHandle = ReturnType<typeof createDb>;

describe('createGithubPoller (cassette)', () => {
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('runs all three sub-polls and lands evidence_log + integration_state rows', {
    timeout: 30_000,
  }, async () => {
    const poller = createGithubPoller({
      token: REPLAY_TOKEN,
      username: RECORDING_USERNAME,
    });

    await poller({ db: dbHandle.db, now: 1_762_500_000_000 });

    // integration_state row exists with completion stamps + a cursor. The
    // adapter reads the cursor before each invocation; the last sub-poll
    // (`pollMentions`) is what overwrites it last, so cursor is whatever
    // mentions saw.
    const state = dbHandle.db.select().from(integrationState).where(eq(integrationState.integration, 'github')).get();
    expect(state?.lastPollStartedAtMs).toBeTypeOf('number');
    expect(state?.lastPollCompletedAtMs).toBeTypeOf('number');
    expect(state?.cursor).toBeTypeOf('string');

    // evidence_log has rows across all three kinds the adapter polls.
    const rows = dbHandle.db.select().from(evidenceLog).where(eq(evidenceLog.integration, 'github')).all();
    expect(rows.length).toBeGreaterThan(0);

    const kinds = new Set(rows.map((r) => r.kind));
    // The cassette has one `/search/issues` recording that Polly replays for
    // every sub-poll (matchRequestsBy.query is false), so each of the three
    // pollers — pollPullRequests, pollIssues, pollMentions — upserts the same
    // response items with its own `kind`-prefixed external_id. All three
    // kinds must therefore be present; a missing kind means a sub-poll
    // didn't run.
    expect(kinds.has('pull_request')).toBe(true);
    expect(kinds.has('issue')).toBe(true);
    expect(kinds.has('mention')).toBe(true);

    // Every row that DID land must be kind-prefixed correctly.
    for (const row of rows) {
      const prefix = row.kind === 'pull_request' ? 'pr_' : row.kind === 'issue' ? 'issue_' : 'mention_';
      expect(row.externalId.startsWith(prefix)).toBe(true);
      expect(row.payloadJson).toBeTypeOf('string');
    }
  });

  it('on second invocation: cursor is threaded as `since` (no duplicate rows, cursor preserved, integration_state re-bracketed)', {
    timeout: 30_000,
  }, async () => {
    const poller = createGithubPoller({
      token: REPLAY_TOKEN,
      username: RECORDING_USERNAME,
    });

    await poller({ db: dbHandle.db, now: 1_762_500_000_000 });

    const beforeRows = dbHandle.db.select().from(evidenceLog).where(eq(evidenceLog.integration, 'github')).all();
    expect(beforeRows.length).toBeGreaterThan(0);
    const beforeExternalIds = beforeRows.map((r) => r.externalId).sort();

    const stateAfterFirst = dbHandle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'github'))
      .get();
    expect(stateAfterFirst).toBeDefined();
    expect(stateAfterFirst?.cursor).toBeTypeOf('string');
    expect(stateAfterFirst?.lastPollCompletedAtMs).toBeTypeOf('number');
    // non-null: presence asserted above
    const cursorAfterFirst = stateAfterFirst!.cursor!;
    // non-null: presence asserted above
    const completedAfterFirst = stateAfterFirst!.lastPollCompletedAtMs!;

    await poller({ db: dbHandle.db, now: 1_762_500_001_000 });

    // Second invocation reads cursorAfterFirst from `integration_state`,
    // threads it as `since` to each sub-poll, so GitHub returns only items
    // updated *after* the prior watermark — typically zero new rows on a
    // back-to-back replay. Three things must hold:
    //
    //   1. No duplicate rows landed: the set of external_ids is unchanged.
    //   2. The cursor was NOT regressed to null. Earlier the adapter had a
    //      bug where pollMentions returning zero items with `since=null`
    //      clobbered the cursor written by pollPullRequests/pollIssues —
    //      threading `since` from `integration_state` before each sub-poll
    //      keeps that fixed.
    //   3. integration_state was re-bracketed (markPollStarted/Completed
    //      ran again, proving the closure executed end-to-end).
    const afterRows = dbHandle.db.select().from(evidenceLog).where(eq(evidenceLog.integration, 'github')).all();
    const afterExternalIds = afterRows.map((r) => r.externalId).sort();
    expect(afterExternalIds).toEqual(beforeExternalIds);

    const stateAfterSecond = dbHandle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'github'))
      .get();
    if (!stateAfterSecond) throw new Error('integration_state row should exist after second poll');
    expect(stateAfterSecond.cursor).toBe(cursorAfterFirst);
    const { lastPollStartedAtMs: startedAt2, lastPollCompletedAtMs: completedAt2 } = stateAfterSecond;
    if (startedAt2 === null || completedAt2 === null) {
      throw new Error('poll watermarks should be set after a completed poll');
    }
    expect(startedAt2).toBeGreaterThan(completedAfterFirst);
    expect(completedAt2).toBeGreaterThanOrEqual(completedAfterFirst);
  });
});
