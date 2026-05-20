/**
 * Pure-ish tests for the evidence-tail response builder. Uses an
 * in-memory SQLite DB seeded with known rows so the test asserts the
 * exact shape end to end (DB → JSON wire payload).
 */

import { createDb, evidenceLog } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildEvidenceTailResponse } from './evidence.ts';

const FIXED_NOW = 1_762_000_000_000;
const ONE_MIN = 60 * 1000;

describe('buildEvidenceTailResponse', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  function seed(overrides: Partial<typeof evidenceLog.$inferInsert> = {}): void {
    const base = {
      integration: 'github',
      externalId: `ext-${Math.random().toString(36).slice(2)}`,
      kind: 'pull_request',
      citationUrl: 'https://github.com/owner/repo/pull/1',
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

  it('returns an empty rows array when DB is empty', () => {
    const r = buildEvidenceTailResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    expect(r.rows).toEqual([]);
    expect(r.total_in_db).toBe(0);
    expect(r.generated_at).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('orders rows newest-first by occurred_at', () => {
    seed({ title: 'oldest', occurredAtMs: FIXED_NOW - 10 * ONE_MIN });
    seed({ title: 'middle', occurredAtMs: FIXED_NOW - 5 * ONE_MIN });
    seed({ title: 'newest', occurredAtMs: FIXED_NOW });
    const r = buildEvidenceTailResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    expect(r.rows.map((row) => row.title)).toEqual(['newest', 'middle', 'oldest']);
    expect(r.total_in_db).toBe(3);
  });

  it('respects the limit cap', () => {
    for (let i = 0; i < 10; i += 1) {
      seed({ title: `row ${i}`, occurredAtMs: FIXED_NOW - i * ONE_MIN });
    }
    const r = buildEvidenceTailResponse({ db: dbHandle.db, limit: 3, nowMs: FIXED_NOW });
    expect(r.rows.length).toBe(3);
    expect(r.total_in_db).toBe(10);
  });

  it('substitutes placeholders for rows with null title', () => {
    seed({ title: null, kind: 'mention', occurredAtMs: FIXED_NOW });
    const r = buildEvidenceTailResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    expect(r.rows.length).toBe(1);
    expect(r.rows[0]?.title).toBe('(no title)');
    expect(r.rows[0]?.kind).toBe('mention');
  });
});
