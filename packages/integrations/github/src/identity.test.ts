import { createDb, identityGraph } from '@slopweaver/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { fetchIdentity } from './identity.ts';

const REPLAY_TOKEN = process.env['GITHUB_PAT'] ?? 'ghp_replay_token_redacted';

let handle: ReturnType<typeof createDb>;

beforeEach(() => {
  handle = createDb({ path: ':memory:' });
});

afterEach(() => {
  handle.close();
});

describe('fetchIdentity', () => {
  it('inserts an identity_graph row for the authenticated user', async () => {
    const { canonicalId, externalId } = await fetchIdentity({
      db: handle.db,
      token: REPLAY_TOKEN,
      now: () => 1000,
    });

    expect(canonicalId).toBe(`github:${externalId}`);

    const row = handle.db
      .select()
      .from(identityGraph)
      .where(eq(identityGraph.integration, 'github'))
      .get();
    expect(row).toMatchObject({
      canonicalId,
      integration: 'github',
      externalId,
      createdAtMs: 1000,
      updatedAtMs: 1000,
    });
    expect(typeof row?.username).toBe('string');
    expect(row?.profileUrl).toMatch(/^https:\/\/github\.com\//);
  });

  it('on second call updates mutable fields but preserves createdAtMs', async () => {
    await fetchIdentity({ db: handle.db, token: REPLAY_TOKEN, now: () => 1000 });
    const before = handle.db
      .select()
      .from(identityGraph)
      .where(eq(identityGraph.integration, 'github'))
      .get();

    await fetchIdentity({ db: handle.db, token: REPLAY_TOKEN, now: () => 2000 });
    const after = handle.db
      .select()
      .from(identityGraph)
      .where(eq(identityGraph.integration, 'github'))
      .get();

    expect(after?.createdAtMs).toBe(before?.createdAtMs);
    expect(after?.updatedAtMs).toBe(2000);
    expect(after?.username).toBe(before?.username);
  });
});
