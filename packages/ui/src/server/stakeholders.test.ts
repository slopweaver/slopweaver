import { createDb, evidenceLog } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildStakeholdersResponse } from './stakeholders.ts';

const FIXED_NOW = 1_762_000_000_000;
const ONE_MIN = 60 * 1000;

describe('buildStakeholdersResponse', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  function seed(overrides: Partial<typeof evidenceLog.$inferInsert>): void {
    const base = {
      integration: 'github',
      externalId: `ext-${Math.random().toString(36).slice(2)}`,
      kind: 'pull_request',
      citationUrl: null,
      title: 'Add widget',
      body: null,
      payloadJson: '{}',
      occurredAtMs: FIXED_NOW - ONE_MIN,
      firstSeenAtMs: FIXED_NOW - ONE_MIN,
      lastSeenAtMs: FIXED_NOW - ONE_MIN,
      createdAtMs: FIXED_NOW - ONE_MIN,
      updatedAtMs: FIXED_NOW - ONE_MIN,
    } satisfies typeof evidenceLog.$inferInsert;
    dbHandle.db
      .insert(evidenceLog)
      .values({ ...base, ...overrides })
      .run();
  }

  it('returns an empty entries array when DB is empty', () => {
    const r = buildStakeholdersResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    expect(r.entries).toEqual([]);
    expect(r.total).toBe(0);
  });

  it('counts interactions per author and orders by count desc', () => {
    seed({ payloadJson: JSON.stringify({ author: 'alice' }) });
    seed({ payloadJson: JSON.stringify({ author: 'alice' }) });
    seed({ payloadJson: JSON.stringify({ author: 'bob' }) });
    const r = buildStakeholdersResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    expect(r.entries.length).toBe(2);
    expect(r.entries[0]?.identifier).toBe('alice');
    expect(r.entries[0]?.interactions).toBe(2);
    expect(r.entries[1]?.identifier).toBe('bob');
    expect(r.entries[1]?.interactions).toBe(1);
  });

  it('records the most-recent last_seen for each identifier', () => {
    seed({
      payloadJson: JSON.stringify({ author: 'alice' }),
      occurredAtMs: FIXED_NOW - 5 * ONE_MIN,
    });
    seed({
      payloadJson: JSON.stringify({ author: 'alice' }),
      occurredAtMs: FIXED_NOW - 1 * ONE_MIN,
    });
    const r = buildStakeholdersResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    expect(r.entries[0]?.last_seen).toBe(new Date(FIXED_NOW - 1 * ONE_MIN).toISOString());
  });

  it('skips rows with missing author', () => {
    seed({ payloadJson: '{}' });
    seed({ payloadJson: JSON.stringify({ author: 'alice' }) });
    const r = buildStakeholdersResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    expect(r.entries.length).toBe(1);
    expect(r.total).toBe(1);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 30; i += 1) seed({ payloadJson: JSON.stringify({ author: `user-${i}` }) });
    const r = buildStakeholdersResponse({ db: dbHandle.db, limit: 5, nowMs: FIXED_NOW });
    expect(r.entries.length).toBe(5);
    expect(r.total).toBe(30);
  });
});
