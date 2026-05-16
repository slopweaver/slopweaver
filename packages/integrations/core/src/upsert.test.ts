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
  it('inserts a new row keyed by (integration, externalId)', async () => {
    const result = await upsertEvidence({
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
    expect(result.isOk()).toBe(true);

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

  it('on conflict updates mutable fields but preserves firstSeenAtMs and createdAtMs', async () => {
    await upsertEvidence({
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

    await upsertEvidence({
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

  it('keeps rows for different integrations independent under the same externalId', async () => {
    await upsertEvidence({
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
    await upsertEvidence({
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
  it('markPollStarted inserts a fresh row when none exists', async () => {
    const result = await markPollStarted({ db: handle.db, integration: 'github', now: 1000 });
    expect(result.isOk()).toBe(true);

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

  it('markPollStarted bumps the timestamp on subsequent calls', async () => {
    await markPollStarted({ db: handle.db, integration: 'github', now: 1000 });
    await markPollStarted({ db: handle.db, integration: 'github', now: 2000 });

    const row = handle.db
      .select()
      .from(integrationState)
      .where(eq(integrationState.integration, 'github'))
      .get();
    expect(row?.lastPollStartedAtMs).toBe(2000);
    expect(row?.updatedAtMs).toBe(2000);
    expect(row?.createdAtMs).toBe(1000);
  });

  it('markPollCompleted writes cursor + completion timestamp', async () => {
    await markPollStarted({ db: handle.db, integration: 'github', now: 1000 });
    const result = await markPollCompleted({
      db: handle.db,
      integration: 'github',
      cursor: '2026-05-01T00:00:00Z',
      now: 1500,
    });
    expect(result.isOk()).toBe(true);

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

  it('markPollCompleted returns ok(0) if markPollStarted never ran', async () => {
    const result = await markPollCompleted({
      db: handle.db,
      integration: 'github',
      cursor: 'x',
      now: 1,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(0);
    }
  });

  it('readCursor returns ok(null) when no row exists', async () => {
    const result = await readCursor({ db: handle.db, integration: 'github' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBeNull();
    }
  });

  it('readCursor returns ok with the stored cursor', async () => {
    await markPollStarted({ db: handle.db, integration: 'github', now: 1000 });
    await markPollCompleted({
      db: handle.db,
      integration: 'github',
      cursor: '2026-05-01T00:00:00Z',
      now: 1500,
    });
    const result = await readCursor({ db: handle.db, integration: 'github' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('2026-05-01T00:00:00Z');
    }
  });
});
