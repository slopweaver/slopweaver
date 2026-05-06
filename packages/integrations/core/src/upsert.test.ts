import { createDb, evidenceLog, integrationState } from '@slopweaver/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { markPollCompleted, markPollStarted, readCursor, upsertEvidence } from './upsert.ts';

let handle: ReturnType<typeof createDb>;

beforeEach(() => {
  handle = createDb({ path: ':memory:' });
});

afterEach(() => {
  handle.close();
});

describe('upsertEvidence', () => {
  it('inserts a new row keyed by (integration, externalId)', () => {
    upsertEvidence({
      db: handle.db,
      integration: 'github',
      externalId: 'pr_1',
      kind: 'pull_request',
      title: 'Fix bug',
      body: 'body text',
      citationUrl: 'https://github.com/x/y/pull/1',
      payloadJson: '{"id":1}',
      occurredAtMs: 100,
      now: 200,
    });

    const rows = handle.db.select().from(evidenceLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      integration: 'github',
      externalId: 'pr_1',
      kind: 'pull_request',
      title: 'Fix bug',
      firstSeenAtMs: 200,
      lastSeenAtMs: 200,
      createdAtMs: 200,
      updatedAtMs: 200,
    });
  });

  it('on conflict updates mutable fields but preserves firstSeenAtMs and createdAtMs', () => {
    upsertEvidence({
      db: handle.db,
      integration: 'github',
      externalId: 'pr_1',
      kind: 'pull_request',
      title: 'Original',
      body: null,
      citationUrl: null,
      payloadJson: '{"v":1}',
      occurredAtMs: 100,
      now: 200,
    });

    upsertEvidence({
      db: handle.db,
      integration: 'github',
      externalId: 'pr_1',
      kind: 'pull_request',
      title: 'Updated',
      body: 'new body',
      citationUrl: 'https://example.com/1',
      payloadJson: '{"v":2}',
      occurredAtMs: 150,
      now: 500,
    });

    const rows = handle.db.select().from(evidenceLog).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      title: 'Updated',
      body: 'new body',
      citationUrl: 'https://example.com/1',
      payloadJson: '{"v":2}',
      occurredAtMs: 150,
      firstSeenAtMs: 200,
      createdAtMs: 200,
      lastSeenAtMs: 500,
      updatedAtMs: 500,
    });
  });

  it('keeps rows for different integrations independent under the same externalId', () => {
    upsertEvidence({
      db: handle.db,
      integration: 'github',
      externalId: 'shared_id',
      kind: 'pull_request',
      title: 'gh',
      body: null,
      citationUrl: null,
      payloadJson: '{}',
      occurredAtMs: 1,
      now: 1,
    });
    upsertEvidence({
      db: handle.db,
      integration: 'slack',
      externalId: 'shared_id',
      kind: 'mention',
      title: 'sl',
      body: null,
      citationUrl: null,
      payloadJson: '{}',
      occurredAtMs: 1,
      now: 1,
    });

    const rows = handle.db.select().from(evidenceLog).all();
    expect(rows).toHaveLength(2);
  });
});

describe('integration_state helpers', () => {
  it('markPollStarted inserts a fresh row when none exists', () => {
    markPollStarted({ db: handle.db, integration: 'github', now: 1000 });

    const row = handle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'github'))
      .get();
    expect(row).toMatchObject({
      integration: 'github',
      cursor: null,
      lastPollStartedAtMs: 1000,
      lastPollCompletedAtMs: null,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    });
  });

  it('markPollStarted bumps the timestamp on subsequent calls', () => {
    markPollStarted({ db: handle.db, integration: 'github', now: 1000 });
    markPollStarted({ db: handle.db, integration: 'github', now: 2000 });

    const row = handle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'github'))
      .get();
    expect(row?.lastPollStartedAtMs).toBe(2000);
    expect(row?.updatedAtMs).toBe(2000);
    expect(row?.createdAtMs).toBe(1000);
  });

  it('markPollCompleted writes cursor + completion timestamp', () => {
    markPollStarted({ db: handle.db, integration: 'github', now: 1000 });
    markPollCompleted({
      db: handle.db,
      integration: 'github',
      cursor: '2026-05-01T00:00:00Z',
      now: 1500,
    });

    const row = handle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'github'))
      .get();
    expect(row).toMatchObject({
      cursor: '2026-05-01T00:00:00Z',
      lastPollCompletedAtMs: 1500,
      updatedAtMs: 1500,
    });
  });

  it('markPollCompleted returns 0 if markPollStarted never ran', () => {
    const changes = markPollCompleted({
      db: handle.db,
      integration: 'github',
      cursor: 'x',
      now: 1,
    });
    expect(changes).toBe(0);
  });

  it('readCursor returns null when no row exists', () => {
    expect(readCursor({ db: handle.db, integration: 'github' })).toBeNull();
  });

  it('readCursor returns the stored cursor', () => {
    markPollStarted({ db: handle.db, integration: 'github', now: 1000 });
    markPollCompleted({
      db: handle.db,
      integration: 'github',
      cursor: '2026-05-01T00:00:00Z',
      now: 1500,
    });
    expect(readCursor({ db: handle.db, integration: 'github' })).toBe('2026-05-01T00:00:00Z');
  });
});
