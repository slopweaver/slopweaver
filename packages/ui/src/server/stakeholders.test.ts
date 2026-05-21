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
    expect(r.unattributed_count).toBe(0);
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

  it('counts unattributed rows separately rather than silently dropping them', () => {
    seed({ payloadJson: '{}' });
    seed({ payloadJson: '{}' });
    seed({ payloadJson: JSON.stringify({ author: 'alice' }) });
    const r = buildStakeholdersResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    expect(r.entries.length).toBe(1);
    expect(r.total).toBe(1);
    expect(r.unattributed_count).toBe(2);
  });

  it('respects the limit', () => {
    for (let i = 0; i < 30; i += 1) seed({ payloadJson: JSON.stringify({ author: `user-${i}` }) });
    const r = buildStakeholdersResponse({ db: dbHandle.db, limit: 5, nowMs: FIXED_NOW });
    expect(r.entries.length).toBe(5);
    expect(r.total).toBe(30);
  });

  // Production payload shapes: both GitHub and Slack pollers normalise a
  // top-level `author` onto payload_json (see polling.ts / upsert.ts), so
  // the aggregation should land on the same author whether the payload
  // came from GitHub (nested `user.login` preserved alongside `author`)
  // or Slack (string `user` preserved alongside `author`). Cover both
  // shapes so regressing the normalisation in either poller would fail
  // here.
  it('groups by the top-level `author` for both GitHub and Slack production payload shapes', () => {
    // GitHub-shaped row: full SearchItem JSON kept, with `author` mirrored
    // from `user.login`.
    seed({
      integration: 'github',
      externalId: 'pr_1',
      kind: 'pull_request',
      payloadJson: JSON.stringify({
        id: 1,
        title: 'Add widget',
        user: { login: 'alice', id: 42 },
        author: 'alice',
      }),
    });
    // Slack-shaped row: message JSON kept, with `author` mirrored from
    // the `user` id string.
    seed({
      integration: 'slack',
      externalId: 'mention_1700000000.000100:C1',
      kind: 'mention',
      payloadJson: JSON.stringify({
        ts: '1700000000.000100',
        user: 'U_ALICE',
        text: 'hey',
        _team_id: 'T0',
        author: 'U_ALICE',
      }),
    });
    seed({
      integration: 'slack',
      externalId: 'mention_1700000001.000100:C1',
      kind: 'mention',
      payloadJson: JSON.stringify({
        ts: '1700000001.000100',
        user: 'U_ALICE',
        text: 'hey again',
        _team_id: 'T0',
        author: 'U_ALICE',
      }),
    });
    const r = buildStakeholdersResponse({ db: dbHandle.db, nowMs: FIXED_NOW });
    // Two distinct identifiers — the GitHub login `alice` and the Slack
    // user id `U_ALICE`. The aggregation doesn't try to merge them (no
    // team_directory yet), but each is attributed via the same
    // `$.author` path.
    expect(r.entries.length).toBe(2);
    const byId = new Map(r.entries.map((e) => [e.identifier, e.interactions]));
    expect(byId.get('U_ALICE')).toBe(2);
    expect(byId.get('alice')).toBe(1);
    expect(r.unattributed_count).toBe(0);
  });
});
