/**
 * End-to-end tests for the recall MCP tool. Seeds the evidence_log,
 * queries, asserts ranked results + the wire-contract via Zod.
 */

import { RecallArgs, RecallResult } from '@slopweaver/contracts';
import { createDb, evidenceLog } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecallTool } from './recall.ts';

const FIXED_NOW = 1_762_000_000_000;
const ONE_MIN = 60 * 1000;

describe('createRecallTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  function seedRow(overrides: Partial<typeof evidenceLog.$inferInsert>): number {
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
    return dbHandle.db
      .insert(evidenceLog)
      .values({ ...base, ...overrides })
      .returning({ id: evidenceLog.id })
      .get().id;
  }

  it('returns hits ranked by cosine similarity', async () => {
    seedRow({ title: 'Authentication migration', body: 'Switching from PAT to OAuth tokens' });
    seedRow({ title: 'Unrelated docs update', body: 'Fixing typos in CONTRIBUTING.md' });
    seedRow({ title: 'OAuth scope changes', body: 'Adjusting OAuth scopes for the new flow' });

    const tool = createRecallTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecallArgs.parse({ query: 'oauth authentication', limit: 5 }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = RecallResult.parse(result.value);
      expect(parsed.hits.length).toBe(2); // the auth rows; not the typos row
      expect(parsed.embedder).toBe('hash-bag-256');
      expect(parsed.hits[0]?.score).toBeGreaterThan(parsed.hits[1]?.score ?? 1.1);
    }
  });

  it('respects the limit argument', async () => {
    for (let i = 0; i < 5; i += 1) {
      seedRow({ title: `auth widget ${i}`, body: 'oauth setup' });
    }
    const tool = createRecallTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecallArgs.parse({ query: 'auth', limit: 2 }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = RecallResult.parse(result.value);
      expect(parsed.hits.length).toBe(2);
    }
  });

  it('filters by integration when supplied', async () => {
    seedRow({ integration: 'github', title: 'github auth' });
    seedRow({ integration: 'slack', title: 'slack auth' });
    const tool = createRecallTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecallArgs.parse({ query: 'auth', filters: { integration: 'slack' } }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = RecallResult.parse(result.value);
      expect(parsed.hits.length).toBe(1);
      expect(parsed.hits[0]?.evidence.integration).toBe('slack');
    }
  });

  it('returns an empty hits list when nothing matches', async () => {
    seedRow({ title: 'completely unrelated', body: 'lorem ipsum' });
    const tool = createRecallTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecallArgs.parse({ query: 'oauth migration' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = RecallResult.parse(result.value);
      expect(parsed.hits).toEqual([]);
    }
  });
});
