/**
 * Tests for fetchIdentity.
 *
 * The Slack client is a `WebClient` partial mock cast at the boundary —
 * standard pattern when faking SDKs in TypeScript. Phase 6 of this PR
 * replaces these fakes with real `WebClient` calls intercepted by Polly
 * cassettes.
 */

import type { WebClient } from '@slack/web-api';
import { identityGraph } from '@slopweaver/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchIdentity } from './identity.ts';
import { openMemoryDb } from './test/db.ts';

type DbHandle = ReturnType<typeof openMemoryDb>;

function fakeWebClient({
  authResponse,
  usersInfoResponse,
}: {
  authResponse: Record<string, unknown>;
  usersInfoResponse: Record<string, unknown>;
}): WebClient {
  return {
    auth: { test: async () => authResponse },
    users: { info: async () => usersInfoResponse },
  } as unknown as WebClient;
}

describe('fetchIdentity', () => {
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = openMemoryDb();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('inserts identity_graph row with deterministic canonical_id slack:<team>:<user>', async () => {
    const client = fakeWebClient({
      authResponse: {
        ok: true,
        user_id: 'U0SLOPBOT',
        user: 'slopbot',
        team_id: 'T0WORKSPACE',
        url: 'https://slopweaver.slack.com/',
      },
      usersInfoResponse: {
        ok: true,
        user: {
          id: 'U0SLOPBOT',
          name: 'slopbot',
          profile: { display_name: 'Slop Bot' },
        },
      },
    });

    const result = await fetchIdentity({
      db: dbHandle.db,
      token: 'xoxb-test',
      client,
      now: () => 1_762_000_000_000,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        canonicalId: 'slack:T0WORKSPACE:U0SLOPBOT',
        externalId: 'U0SLOPBOT',
      });
    }

    const rows = dbHandle.db
      .select()
      .from(identityGraph)
      .where(eq(identityGraph.externalId, 'U0SLOPBOT'))
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      canonicalId: 'slack:T0WORKSPACE:U0SLOPBOT',
      integration: 'slack',
      externalId: 'U0SLOPBOT',
      username: 'slopbot',
      displayName: 'Slop Bot',
      profileUrl: 'https://slopweaver.slack.com/team/U0SLOPBOT',
      createdAtMs: 1_762_000_000_000,
      updatedAtMs: 1_762_000_000_000,
    });
  });

  it('two machines on the same workspace agree on canonical_id by construction', async () => {
    // The deterministic format means two independent installs polling the
    // same workspace produce the same canonical_id without coordination.
    const auth = { ok: true, user_id: 'U0', user: 'a', team_id: 'T0' };
    const profile = { ok: true, user: { id: 'U0', name: 'a' } };

    const machineA = fakeWebClient({ authResponse: auth, usersInfoResponse: profile });
    const dbA = openMemoryDb();
    const dbB = openMemoryDb();
    try {
      const a = await fetchIdentity({
        db: dbA.db,
        token: 'xoxb-test',
        client: machineA,
        now: () => 1,
      });
      const b = await fetchIdentity({
        db: dbB.db,
        token: 'xoxb-test',
        client: fakeWebClient({ authResponse: auth, usersInfoResponse: profile }),
        now: () => 2,
      });
      expect(a.isOk()).toBe(true);
      expect(b.isOk()).toBe(true);
      if (a.isOk() && b.isOk()) {
        expect(a.value.canonicalId).toBe(b.value.canonicalId);
        expect(a.value.canonicalId).toBe('slack:T0:U0');
      }
    } finally {
      dbA.close();
      dbB.close();
    }
  });

  it('preserves canonical_id and created_at_ms across re-runs while refreshing the snapshot', async () => {
    const initialClient = fakeWebClient({
      authResponse: { ok: true, user_id: 'U0SLOPBOT', user: 'slopbot', team_id: 'T0WORKSPACE' },
      usersInfoResponse: {
        ok: true,
        user: { id: 'U0SLOPBOT', name: 'slopbot', profile: { display_name: 'Slop Bot' } },
      },
    });

    await fetchIdentity({
      db: dbHandle.db,
      token: 'xoxb-test',
      client: initialClient,
      now: () => 1_000,
    });

    const refreshedClient = fakeWebClient({
      authResponse: { ok: true, user_id: 'U0SLOPBOT', user: 'slopbot', team_id: 'T0WORKSPACE' },
      usersInfoResponse: {
        ok: true,
        user: { id: 'U0SLOPBOT', name: 'slopbot', profile: { display_name: 'Slop Bot v2' } },
      },
    });

    const result = await fetchIdentity({
      db: dbHandle.db,
      token: 'xoxb-test',
      client: refreshedClient,
      now: () => 5_000,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.canonicalId).toBe('slack:T0WORKSPACE:U0SLOPBOT');
    }

    const rows = dbHandle.db.select().from(identityGraph).all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      canonicalId: 'slack:T0WORKSPACE:U0SLOPBOT',
      displayName: 'Slop Bot v2',
      createdAtMs: 1_000,
      updatedAtMs: 5_000,
    });
  });

  it('falls back to real_name when display_name is empty', async () => {
    const client = fakeWebClient({
      authResponse: { ok: true, user_id: 'U1', user: 'alice', team_id: 'T1' },
      usersInfoResponse: {
        ok: true,
        user: {
          id: 'U1',
          name: 'alice',
          profile: { display_name: '', real_name: 'Alice Liddell' },
        },
      },
    });

    await fetchIdentity({
      db: dbHandle.db,
      token: 'xoxp-test',
      client,
      now: () => 1,
    });

    const row = dbHandle.db.select().from(identityGraph).get();
    expect(row?.displayName).toBe('Alice Liddell');
  });

  it('returns err with SLACK_API_ERROR when slack.auth.test throws', async () => {
    const client = {
      auth: {
        test: async () => {
          throw new Error('An API error occurred: invalid_auth');
        },
      },
      users: { info: async () => ({ ok: true, user: { id: 'unused' } }) },
    } as unknown as WebClient;

    const result = await fetchIdentity({
      db: dbHandle.db,
      token: 'xoxb-test',
      client,
      now: () => 1,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('SLACK_API_ERROR');
      if (result.error.code === 'SLACK_API_ERROR') {
        expect(result.error.endpoint).toBe('auth.test');
      }
    }
  });
});

describe('fetchIdentity (cassette)', () => {
  // Smoke test against a recorded cassette. The cassette was scrubbed by
  // src/test/redact-slack.ts at record-time, so assertions only check shape:
  // - canonicalId matches slack:<team>:<user>
  // - identity_graph row exists with the right structural fields
  // - mutable PII (display name) is whatever survived redaction
  let dbHandle: DbHandle;

  beforeEach(() => {
    dbHandle = openMemoryDb();
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('records and replays a real workspace identity fetch', async () => {
    const result = await fetchIdentity({
      db: dbHandle.db,
      token: process.env['SLACK_USER_TOKEN'] ?? 'xoxp-replay-token',
      now: () => 1_000,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.canonicalId).toMatch(/^slack:T[A-Z0-9]+:U[A-Z0-9]+$/);
      expect(result.value.externalId).toMatch(/^U[A-Z0-9]+$/);

      const row = dbHandle.db.select().from(identityGraph).get();
      expect(row).toMatchObject({
        canonicalId: result.value.canonicalId,
        integration: 'slack',
        externalId: result.value.externalId,
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
      });
    }
  });
});
