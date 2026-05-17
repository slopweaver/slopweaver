import { CatchMeUpArgs, CatchMeUpResult } from '@slopweaver/contracts';
import { createDb, evidenceLog } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCatchMeUpTool } from './catch-me-up.ts';

const FIXED_NOW = 1_762_000_000_000;
const ONE_MIN = 60 * 1000;

describe('createCatchMeUpTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  function seedEvidence(overrides: Partial<typeof evidenceLog.$inferInsert>): number {
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

  async function callHandler(
    tool: ReturnType<typeof createCatchMeUpTool>,
    rawInput: unknown,
  ): Promise<unknown> {
    const input = CatchMeUpArgs.parse(rawInput);
    const result = await tool.handler({ input, ctx: { db: dbHandle.db } });
    if (result.isErr()) {
      throw new Error(`catch_me_up handler returned Err: ${result.error.code}`);
    }
    return result.value;
  }

  it('returns an empty evidence array when the DB is empty', async () => {
    const tool = createCatchMeUpTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { since: new Date(FIXED_NOW - ONE_MIN).toISOString() });
    const parsed = CatchMeUpResult.parse(raw);

    expect(parsed.evidence).toEqual([]);
    expect(parsed.generated_at).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('excludes rows older than `since`', async () => {
    seedEvidence({
      externalId: 'old-pr',
      title: 'old PR',
      occurredAtMs: FIXED_NOW - 10 * ONE_MIN,
    });
    seedEvidence({
      externalId: 'new-pr',
      title: 'new PR',
      occurredAtMs: FIXED_NOW - ONE_MIN,
    });

    const tool = createCatchMeUpTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { since: new Date(FIXED_NOW - 5 * ONE_MIN).toISOString() });
    const parsed = CatchMeUpResult.parse(raw);

    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.ref).toEqual({
      kind: 'canonical',
      integration: 'github',
      id: 'new-pr',
    });
  });

  it('includes rows whose occurred_at_ms equals `since` (gte boundary)', async () => {
    seedEvidence({
      externalId: 'boundary',
      occurredAtMs: FIXED_NOW - 5 * ONE_MIN,
    });

    const tool = createCatchMeUpTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { since: new Date(FIXED_NOW - 5 * ONE_MIN).toISOString() });
    const parsed = CatchMeUpResult.parse(raw);

    expect(parsed.evidence).toHaveLength(1);
  });

  it('orders results by occurred_at_ms descending (newest first)', async () => {
    seedEvidence({ externalId: 'a', occurredAtMs: FIXED_NOW - 3 * ONE_MIN });
    seedEvidence({ externalId: 'b', occurredAtMs: FIXED_NOW - ONE_MIN });
    seedEvidence({ externalId: 'c', occurredAtMs: FIXED_NOW - 2 * ONE_MIN });

    const tool = createCatchMeUpTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {
      since: new Date(FIXED_NOW - 10 * ONE_MIN).toISOString(),
    });
    const parsed = CatchMeUpResult.parse(raw);

    const externalIds = parsed.evidence.map((e) => (e.ref.kind === 'canonical' ? e.ref.id : null));
    expect(externalIds).toEqual(['b', 'c', 'a']);
  });

  it('caps the result set at 50 entries even when more rows match', async () => {
    for (let i = 0; i < 75; i++) {
      seedEvidence({
        externalId: `pr-${i}`,
        occurredAtMs: FIXED_NOW - (75 - i) * ONE_MIN,
      });
    }

    const tool = createCatchMeUpTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {
      since: new Date(FIXED_NOW - 100 * ONE_MIN).toISOString(),
    });
    const parsed = CatchMeUpResult.parse(raw);

    expect(parsed.evidence).toHaveLength(50);
    // newest 50 are pr-74 .. pr-25; pr-74 should be first
    const first = parsed.evidence[0];
    const last = parsed.evidence[49];
    expect(first && first.ref.kind === 'canonical' ? first.ref.id : null).toBe('pr-74');
    expect(last && last.ref.kind === 'canonical' ? last.ref.id : null).toBe('pr-25');
  });

  it('shapes citation_url into a url-kind ref when valid', async () => {
    seedEvidence({
      externalId: 'pr-with-url',
      citationUrl: 'https://github.com/example/repo/pull/1',
      occurredAtMs: FIXED_NOW - ONE_MIN,
    });

    const tool = createCatchMeUpTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {
      since: new Date(FIXED_NOW - 10 * ONE_MIN).toISOString(),
    });
    const parsed = CatchMeUpResult.parse(raw);

    expect(parsed.evidence[0]?.ref).toEqual({
      kind: 'url',
      url: 'https://github.com/example/repo/pull/1',
    });
    expect(parsed.evidence[0]?.citation_url).toBe('https://github.com/example/repo/pull/1');
  });
});
