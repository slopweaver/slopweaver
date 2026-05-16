import { createDb, evidenceLog, integrationState } from '@slopweaver/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pollIssues, pollMentions, pollPullRequests } from './polling.ts';

const REPLAY_TOKEN = process.env['GH_TOKEN'] ?? 'ghp_replay_token_redacted';

let handle: ReturnType<typeof createDb>;

beforeEach(() => {
  handle = createDb({ path: ':memory:' });
});

afterEach(() => {
  handle.close();
});

describe('pollPullRequests', () => {
  it('upserts each returned PR into evidence_log and bumps integration_state', async () => {
    const value = (
      await pollPullRequests({
        db: handle.db,
        token: REPLAY_TOKEN,
        since: null,
      })
    )._unsafeUnwrap();

    const rows = handle.db
      .select()
      .from(evidenceLog)
      .where(eq(evidenceLog.kind, 'pull_request'))
      .all();
    expect(rows.length).toBe(value.fetched);
    expect(value.fetched).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.integration).toBe('github');
      expect(row.externalId.startsWith('pr_')).toBe(true);
      expect(row.payloadJson).toBeTruthy();
    }

    const state = handle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'github'))
      .get();
    expect(state?.lastPollCompletedAtMs).toBeTypeOf('number');
    expect(state?.cursor).toBe(value.newCursor);
  });

  it('is idempotent on repeat polls (row count stays, lastSeenAtMs advances)', async () => {
    let counter = 1000;
    const stepClock = (): number => {
      counter += 100;
      return counter;
    };

    const first = await pollPullRequests({
      db: handle.db,
      token: REPLAY_TOKEN,
      since: null,
      now: stepClock,
    });
    expect(first.isOk()).toBe(true);

    const beforeRows = handle.db
      .select()
      .from(evidenceLog)
      .where(eq(evidenceLog.kind, 'pull_request'))
      .all();
    const beforeCount = beforeRows.length;
    expect(beforeCount).toBeGreaterThan(0);
    // Track a specific row by externalId so the after-poll assertion compares
    // the same record (SQLite doesn't guarantee insert order on plain SELECT).
    const trackedExternalId = beforeRows[0]?.externalId;
    expect(trackedExternalId).toBeDefined();
    const beforeTracked = beforeRows.find((r) => r.externalId === trackedExternalId);

    const second = await pollPullRequests({
      db: handle.db,
      token: REPLAY_TOKEN,
      since: null,
      now: stepClock,
    });
    expect(second.isOk()).toBe(true);

    const afterRows = handle.db
      .select()
      .from(evidenceLog)
      .where(eq(evidenceLog.kind, 'pull_request'))
      .all();
    const afterTracked = afterRows.find((r) => r.externalId === trackedExternalId);

    expect(afterRows.length).toBe(beforeCount);
    expect(afterTracked?.lastSeenAtMs ?? 0).toBeGreaterThan(beforeTracked?.lastSeenAtMs ?? 0);
    expect(afterTracked?.firstSeenAtMs).toBe(beforeTracked?.firstSeenAtMs);
  });
});

describe('pollIssues', () => {
  it('writes issue rows with kind="issue" and prefixed external_id', async () => {
    const value = (
      await pollIssues({
        db: handle.db,
        token: REPLAY_TOKEN,
        since: null,
      })
    )._unsafeUnwrap();

    const rows = handle.db.select().from(evidenceLog).where(eq(evidenceLog.kind, 'issue')).all();
    expect(rows.length).toBe(value.fetched);
    for (const row of rows) {
      expect(row.externalId.startsWith('issue_')).toBe(true);
    }
  });
});

describe('pollMentions', () => {
  it('writes mention rows with kind="mention" and prefixed external_id', async () => {
    const value = (
      await pollMentions({
        db: handle.db,
        token: REPLAY_TOKEN,
        since: null,
        // GitHub's `mentions:` qualifier rejects `@me`; the maintainer's public
        // login is fine to bake into a cassette URL (user logins are public).
        username: 'lachiejames',
      })
    )._unsafeUnwrap();

    const rows = handle.db.select().from(evidenceLog).where(eq(evidenceLog.kind, 'mention')).all();
    expect(rows.length).toBe(value.fetched);
    for (const row of rows) {
      expect(row.externalId.startsWith('mention_')).toBe(true);
    }
  });
});
