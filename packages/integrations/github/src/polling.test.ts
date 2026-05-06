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
    const result = await pollPullRequests({
      db: handle.db,
      token: REPLAY_TOKEN,
      since: null,
    });

    const rows = handle.db
      .select()
      .from(evidenceLog)
      .where(eq(evidenceLog.kind, 'pull_request'))
      .all();
    expect(rows.length).toBe(result.fetched);
    expect(result.fetched).toBeGreaterThan(0);
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
    expect(state?.cursor).toBe(result.newCursor);
  });

  it('is idempotent on repeat polls (row count stays, lastSeenAtMs advances)', async () => {
    let counter = 1000;
    const stepClock = (): number => {
      counter += 100;
      return counter;
    };

    await pollPullRequests({
      db: handle.db,
      token: REPLAY_TOKEN,
      since: null,
      now: stepClock,
    });
    const beforeRows = handle.db
      .select()
      .from(evidenceLog)
      .where(eq(evidenceLog.kind, 'pull_request'))
      .all();
    const beforeCount = beforeRows.length;
    const beforeLastSeen = beforeRows[0]?.lastSeenAtMs ?? 0;

    await pollPullRequests({
      db: handle.db,
      token: REPLAY_TOKEN,
      since: null,
      now: stepClock,
    });
    const afterRows = handle.db
      .select()
      .from(evidenceLog)
      .where(eq(evidenceLog.kind, 'pull_request'))
      .all();

    expect(afterRows.length).toBe(beforeCount);
    expect(afterRows[0]?.lastSeenAtMs ?? 0).toBeGreaterThan(beforeLastSeen);
    expect(afterRows[0]?.firstSeenAtMs).toBe(beforeRows[0]?.firstSeenAtMs);
  });
});

describe('pollIssues', () => {
  it('writes issue rows with kind="issue" and prefixed external_id', async () => {
    const result = await pollIssues({
      db: handle.db,
      token: REPLAY_TOKEN,
      since: null,
    });

    const rows = handle.db.select().from(evidenceLog).where(eq(evidenceLog.kind, 'issue')).all();
    expect(rows.length).toBe(result.fetched);
    for (const row of rows) {
      expect(row.externalId.startsWith('issue_')).toBe(true);
    }
  });
});

describe('pollMentions', () => {
  it('writes mention rows with kind="mention" and prefixed external_id', async () => {
    const result = await pollMentions({
      db: handle.db,
      token: REPLAY_TOKEN,
      since: null,
      // GitHub's `mentions:` qualifier rejects `@me`; the maintainer's public
      // login is fine to bake into a cassette URL (user logins are public).
      username: 'lachiejames',
    });

    const rows = handle.db.select().from(evidenceLog).where(eq(evidenceLog.kind, 'mention')).all();
    expect(rows.length).toBe(result.fetched);
    for (const row of rows) {
      expect(row.externalId.startsWith('mention_')).toBe(true);
    }
  });
});
