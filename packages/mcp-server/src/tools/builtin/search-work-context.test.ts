import { SearchWorkContextArgs, SearchWorkContextResult } from '@slopweaver/contracts';
import { createDb, evidenceLog } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSearchWorkContextTool } from './search-work-context.ts';

const FIXED_NOW = 1_762_000_000_000;
const ONE_MIN = 60 * 1000;

describe('createSearchWorkContextTool', () => {
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
      title: null,
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
    tool: ReturnType<typeof createSearchWorkContextTool>,
    rawInput: unknown,
  ): Promise<unknown> {
    const input = SearchWorkContextArgs.parse(rawInput);
    const result = await tool.handler({ input, ctx: { db: dbHandle.db } });
    if (result.isErr()) {
      throw new Error(`search_work_context handler returned Err: ${result.error.code}`);
    }
    return result.value;
  }

  it('returns an empty evidence array when no rows match', async () => {
    seedEvidence({ title: 'a different topic' });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { query: 'nonexistent' });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toEqual([]);
    expect(parsed.generated_at).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('matches against title', async () => {
    seedEvidence({ externalId: 'pr-widget', title: 'Add widget feature', body: 'noise' });
    seedEvidence({ externalId: 'pr-other', title: 'Unrelated work', body: 'noise' });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { query: 'widget' });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.ref).toEqual({
      kind: 'canonical',
      integration: 'github',
      id: 'pr-widget',
    });
  });

  it('matches against body', async () => {
    seedEvidence({
      externalId: 'pr-body-hit',
      title: 'PR',
      body: 'Implements the widget refactor',
    });
    seedEvidence({ externalId: 'pr-miss', title: 'PR', body: 'Different topic entirely' });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { query: 'widget' });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.ref).toEqual({
      kind: 'canonical',
      integration: 'github',
      id: 'pr-body-hit',
    });
  });

  it('honours the integration filter', async () => {
    seedEvidence({
      integration: 'github',
      externalId: 'gh-1',
      title: 'widget pull request',
    });
    seedEvidence({
      integration: 'slack',
      externalId: 'sl-1',
      kind: 'mention',
      title: 'widget chatter',
    });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {
      query: 'widget',
      filters: { integration: 'slack' },
    });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.integration).toBe('slack');
  });

  it('honours the kind filter', async () => {
    seedEvidence({
      integration: 'github',
      externalId: 'gh-pr',
      kind: 'pull_request',
      title: 'widget PR',
    });
    seedEvidence({
      integration: 'github',
      externalId: 'gh-issue',
      kind: 'issue',
      title: 'widget issue',
    });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {
      query: 'widget',
      filters: { kind: 'issue' },
    });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.kind).toBe('issue');
  });

  it('combines integration and kind filters', async () => {
    seedEvidence({ integration: 'github', externalId: 'a', kind: 'pull_request', title: 'widget' });
    seedEvidence({ integration: 'github', externalId: 'b', kind: 'issue', title: 'widget' });
    seedEvidence({ integration: 'slack', externalId: 'c', kind: 'mention', title: 'widget' });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {
      query: 'widget',
      filters: { integration: 'github', kind: 'issue' },
    });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.ref).toEqual({
      kind: 'canonical',
      integration: 'github',
      id: 'b',
    });
  });

  it('does not throw when the query contains FTS5 operator characters', async () => {
    seedEvidence({ title: 'normal title' });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    // Each of these would be interpreted as syntax by FTS5 if passed unsanitized.
    const queries = ['foo OR bar', 'a*b', '"unclosed', '(parens)', 'has:colon', 'AND'];

    for (const query of queries) {
      const result = await tool.handler({
        input: SearchWorkContextArgs.parse({ query }),
        ctx: { db: dbHandle.db },
      });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        SearchWorkContextResult.parse(result.value);
      }
    }
  });

  it('treats whitespace-separated tokens as implicit AND', async () => {
    seedEvidence({ externalId: 'both', title: 'widget and gadget pair' });
    seedEvidence({ externalId: 'widget-only', title: 'lone widget here' });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { query: 'widget gadget' });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.ref).toEqual({
      kind: 'canonical',
      integration: 'github',
      id: 'both',
    });
  });

  it('orders results by FTS5 rank (more relevant matches first)', async () => {
    // Row with 'widget' appearing twice should rank higher than a row with it once.
    seedEvidence({
      externalId: 'two-hits',
      title: 'widget improvements',
      body: 'this widget refactor',
    });
    seedEvidence({
      externalId: 'one-hit',
      title: 'one widget',
      body: 'no other matches at all',
    });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { query: 'widget' });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.evidence[0]?.ref).toEqual({
      kind: 'canonical',
      integration: 'github',
      id: 'two-hits',
    });
  });

  it('caps the result set at 50 entries', async () => {
    for (let i = 0; i < 60; i++) {
      seedEvidence({ externalId: `pr-${i}`, title: `widget number ${i}` });
    }

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { query: 'widget' });
    const parsed = SearchWorkContextResult.parse(raw);

    expect(parsed.evidence).toHaveLength(50);
  });

  it('returns empty evidence when the query collapses to whitespace after trimming', async () => {
    seedEvidence({ title: 'some content' });

    const tool = createSearchWorkContextTool({ now: () => FIXED_NOW });
    // Schema requires non-empty, but pure-whitespace strings pass; sanitizer
    // strips them and we short-circuit before issuing the FTS5 query.
    const result = await tool.handler({
      input: SearchWorkContextArgs.parse({ query: '   ' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.evidence).toEqual([]);
    }
  });
});
