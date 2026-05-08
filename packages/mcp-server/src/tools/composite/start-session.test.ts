/**
 * Unit tests for the start_session composite tool. Exercises the handler
 * directly (faster, more focused than going through MCP transport — there is
 * one transport-level smoke test in `server.test.ts` that pins the wire
 * shape).
 *
 * Each test uses a fresh in-memory SQLite DB seeded directly via Drizzle.
 * Time is pinned via the `now` factory arg so age-dependent ranking and
 * staleness checks are deterministic.
 */

import { evidenceLog, integrationState, createDb } from '@slopweaver/db';
import { StartSessionArgs, StartSessionResult } from '@slopweaver/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createStartSessionTool, type StartSessionPoller } from './start-session.ts';

const FIXED_NOW = 1_762_000_000_000;
const FIVE_MIN = 5 * 60 * 1000;
const ELEVEN_MIN = 11 * 60 * 1000;

describe('createStartSessionTool', () => {
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
      occurredAtMs: FIXED_NOW - FIVE_MIN,
      firstSeenAtMs: FIXED_NOW - FIVE_MIN,
      lastSeenAtMs: FIXED_NOW - FIVE_MIN,
      createdAtMs: FIXED_NOW - FIVE_MIN,
      updatedAtMs: FIXED_NOW - FIVE_MIN,
    } satisfies typeof evidenceLog.$inferInsert;
    const result = dbHandle.db
      .insert(evidenceLog)
      .values({ ...base, ...overrides })
      .returning({ id: evidenceLog.id })
      .get();
    return result.id;
  }

  function seedFreshIntegrationState(integration: string, lastCompleted = FIXED_NOW - FIVE_MIN) {
    dbHandle.db
      .insert(integrationState)
      .values({
        integration,
        cursor: null,
        lastPollStartedAtMs: lastCompleted,
        lastPollCompletedAtMs: lastCompleted,
        createdAtMs: lastCompleted,
        updatedAtMs: lastCompleted,
      })
      .run();
  }

  function callHandler(
    tool: ReturnType<typeof createStartSessionTool>,
    rawInput: unknown,
  ): Promise<unknown> {
    // Mirror the SDK's pre-handler validation step so handler input is typed.
    const input = StartSessionArgs.parse(rawInput);
    return tool.handler({ input, ctx: { db: dbHandle.db } });
  }

  it('happy path: ranks a Slack mention above an equal-recency GitHub PR via the kind boost', async () => {
    seedEvidence({
      integration: 'github',
      externalId: 'pr-1',
      kind: 'pull_request',
      title: 'Add widget',
      citationUrl: 'https://github.com/example/repo/pull/1',
      occurredAtMs: FIXED_NOW - FIVE_MIN,
    });
    seedEvidence({
      integration: 'slack',
      externalId: 'msg-1',
      kind: 'mention',
      title: '@you take a look?',
      citationUrl: 'https://slack.example.com/archives/C1/p1',
      occurredAtMs: FIXED_NOW - FIVE_MIN,
    });
    seedFreshIntegrationState('github');
    seedFreshIntegrationState('slack');

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = StartSessionResult.parse(raw);

    expect(parsed.items).toHaveLength(2);
    expect(parsed.items[0]?.priority).toBe(1);
    expect(parsed.items[0]?.title).toBe('@you take a look?');
    expect(parsed.items[1]?.priority).toBe(2);
    expect(parsed.items[1]?.title).toBe('Add widget');

    expect(parsed.evidence).toHaveLength(2);
    expect(parsed.evidence.map((e) => e.integration)).toEqual(
      expect.arrayContaining(['github', 'slack']),
    );

    expect(parsed.freshness).toHaveLength(2);
    for (const f of parsed.freshness) {
      expect(f.stale).toBe(false);
      expect(typeof f.last_polled_at).toBe('string');
    }

    expect(() => new Date(parsed.generated_at)).not.toThrow();
  });

  it('returns empty arrays with a valid generated_at when the DB is empty', async () => {
    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = StartSessionResult.parse(raw);

    expect(parsed.items).toEqual([]);
    expect(parsed.evidence).toEqual([]);
    expect(parsed.freshness).toEqual([]);
    expect(parsed.generated_at).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('integrations filter excludes rows from other integrations', async () => {
    seedEvidence({ integration: 'github', externalId: 'pr-1', kind: 'pull_request' });
    seedEvidence({ integration: 'slack', externalId: 'msg-1', kind: 'mention' });
    seedFreshIntegrationState('github');
    seedFreshIntegrationState('slack');

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { integrations: ['github'] });
    const parsed = StartSessionResult.parse(raw);

    expect(parsed.items.every((i) => i.title !== '@you take a look?')).toBe(true);
    expect(parsed.evidence).toHaveLength(1);
    expect(parsed.evidence[0]?.integration).toBe('github');
    expect(parsed.freshness).toHaveLength(1);
    expect(parsed.freshness[0]?.integration).toBe('github');
  });

  it('caps results to max_items and rejects out-of-range max_items at the schema boundary', async () => {
    for (let i = 0; i < 5; i += 1) {
      seedEvidence({
        externalId: `pr-${i}`,
        occurredAtMs: FIXED_NOW - i * 60_000,
      });
    }
    seedFreshIntegrationState('github');

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { max_items: 2 });
    const parsed = StartSessionResult.parse(raw);

    expect(parsed.items).toHaveLength(2);
    expect(parsed.evidence).toHaveLength(2);

    // Schema enforces max(25). 30 must be rejected at the SDK boundary —
    // mirror that here by parsing the raw input.
    expect(() => StartSessionArgs.parse({ max_items: 30 })).toThrow();
  });

  it('force_refresh invokes the registered poller exactly once per integration', async () => {
    seedFreshIntegrationState('github');

    const githubPoller: StartSessionPoller = vi.fn(async ({ db, now }) => {
      db.insert(evidenceLog)
        .values({
          integration: 'github',
          externalId: 'fresh-1',
          kind: 'pull_request',
          citationUrl: null,
          title: 'Fresh PR',
          body: null,
          payloadJson: '{}',
          occurredAtMs: now - 1_000,
          firstSeenAtMs: now,
          lastSeenAtMs: now,
          createdAtMs: now,
          updatedAtMs: now,
        })
        .run();
    });

    const tool = createStartSessionTool({
      now: () => FIXED_NOW,
      pollers: { github: githubPoller },
    });
    const raw = await callHandler(tool, { force_refresh: true });
    const parsed = StartSessionResult.parse(raw);

    expect(githubPoller).toHaveBeenCalledTimes(1);
    expect(githubPoller).toHaveBeenCalledWith({ db: dbHandle.db, now: FIXED_NOW });
    expect(parsed.items.map((i) => i.title)).toContain('Fresh PR');
  });

  it('auto-polls when integration_state is older than the staleness threshold', async () => {
    const stalePoller: StartSessionPoller = vi.fn(async () => {});
    seedFreshIntegrationState('github', FIXED_NOW - ELEVEN_MIN);

    const tool = createStartSessionTool({
      now: () => FIXED_NOW,
      pollers: { github: stalePoller },
    });
    await callHandler(tool, {});
    expect(stalePoller).toHaveBeenCalledTimes(1);

    // Reset to fresh; poller must NOT fire again.
    dbHandle.db.delete(integrationState).run();
    seedFreshIntegrationState('github', FIXED_NOW - FIVE_MIN);
    const freshPoller: StartSessionPoller = vi.fn(async () => {});
    const tool2 = createStartSessionTool({
      now: () => FIXED_NOW,
      pollers: { github: freshPoller },
    });
    await callHandler(tool2, {});
    expect(freshPoller).not.toHaveBeenCalled();
  });

  it('reports stale=true and last_polled_at=null when no integration_state row exists', async () => {
    seedEvidence({ integration: 'github', externalId: 'pr-1' });

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, { integrations: ['github'] });
    const parsed = StartSessionResult.parse(raw);

    expect(parsed.freshness).toEqual([
      { integration: 'github', last_polled_at: null, stale: true },
    ]);
  });

  it('builds Reference as kind:url when citation_url is present, else kind:canonical', async () => {
    seedEvidence({
      integration: 'github',
      externalId: 'pr-with-url',
      citationUrl: 'https://github.com/example/repo/pull/9',
      occurredAtMs: FIXED_NOW - FIVE_MIN,
    });
    seedEvidence({
      integration: 'github',
      externalId: 'pr-without-url',
      citationUrl: null,
      occurredAtMs: FIXED_NOW - FIVE_MIN - 1_000,
    });
    seedFreshIntegrationState('github');

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = StartSessionResult.parse(raw);

    const withUrl = parsed.evidence.find((e) => e.citation_url != null);
    const withoutUrl = parsed.evidence.find((e) => e.citation_url == null);

    expect(withUrl?.ref).toEqual({
      kind: 'url',
      url: 'https://github.com/example/repo/pull/9',
    });
    expect(withoutUrl?.ref).toEqual({
      kind: 'canonical',
      integration: 'github',
      id: 'pr-without-url',
    });

    // id is stringified at the boundary; occurred_at is an ISO datetime.
    for (const e of parsed.evidence) {
      expect(typeof e.id).toBe('string');
      expect(e.id.length).toBeGreaterThan(0);
      expect(() => new Date(e.occurred_at).toISOString()).not.toThrow();
    }
  });

  it('dedupes a duplicated `integrations` argument so each integration is processed once', async () => {
    seedEvidence({ integration: 'github', externalId: 'pr-1' });
    seedFreshIntegrationState('github');

    const githubPoller: StartSessionPoller = vi.fn(async () => {});
    const tool = createStartSessionTool({
      now: () => FIXED_NOW,
      pollers: { github: githubPoller },
    });
    const raw = await callHandler(tool, {
      integrations: ['github', 'github'],
      force_refresh: true,
    });
    const parsed = StartSessionResult.parse(raw);

    expect(githubPoller).toHaveBeenCalledTimes(1);
    expect(parsed.freshness).toHaveLength(1);
    expect(parsed.freshness[0]?.integration).toBe('github');
  });

  it('force_refresh polls a registered integration that has no integration_state row yet', async () => {
    // No state row, no evidence — this is the first-run case.
    const githubPoller: StartSessionPoller = vi.fn(async () => {});
    const tool = createStartSessionTool({
      now: () => FIXED_NOW,
      pollers: { github: githubPoller },
    });
    const raw = await callHandler(tool, { force_refresh: true });
    const parsed = StartSessionResult.parse(raw);

    expect(githubPoller).toHaveBeenCalledTimes(1);
    expect(parsed.freshness).toEqual([
      { integration: 'github', last_polled_at: null, stale: true },
    ]);
  });

  it('skips rows with no usable title, downgrades malformed citation_url, tolerates bad payload_json', async () => {
    // Row 1: empty title and empty kind — must be skipped entirely.
    seedEvidence({
      integration: 'github',
      externalId: 'no-title',
      title: '',
      kind: '',
      occurredAtMs: FIXED_NOW - 60_000,
    });
    // Row 2: malformed citation_url — must downgrade to canonical ref.
    seedEvidence({
      integration: 'github',
      externalId: 'bad-url',
      title: 'Has bad URL',
      citationUrl: 'not a real url',
      occurredAtMs: FIXED_NOW - 120_000,
    });
    // Row 3: malformed JSON payload — must surface with payload_json: null.
    seedEvidence({
      integration: 'github',
      externalId: 'bad-json',
      title: 'Has bad JSON',
      payloadJson: '{not json',
      occurredAtMs: FIXED_NOW - 180_000,
    });
    seedFreshIntegrationState('github');

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = StartSessionResult.parse(raw);

    expect(parsed.items.map((i) => i.title)).toEqual(['Has bad URL', 'Has bad JSON']);

    const downgraded = parsed.evidence.find(
      (e) => e.ref.kind === 'canonical' && e.ref.id === 'bad-url',
    );
    expect(downgraded).toBeDefined();
    expect(downgraded?.citation_url).toBeNull();

    const badJson = parsed.evidence.find(
      (e) => e.ref.kind === 'canonical' && e.ref.id === 'bad-json',
    );
    expect(badJson).toBeDefined();
    expect(badJson?.payload_json).toBeNull();
  });

  it('orders by score desc — a higher-score row beats a more recent lower-score row', async () => {
    // 'mention' wins the kind boost (+0.5). Even though the PR is more recent,
    // the score-desc tier puts the older mention first.
    seedEvidence({
      integration: 'slack',
      externalId: 'older-mention',
      title: 'Older Mention',
      kind: 'mention',
      occurredAtMs: FIXED_NOW - 60 * 60_000, // 1 hour ago
    });
    seedEvidence({
      integration: 'github',
      externalId: 'newer-pr',
      title: 'Newer PR',
      kind: 'pull_request',
      occurredAtMs: FIXED_NOW - 5 * 60_000, // 5 minutes ago
    });
    seedFreshIntegrationState('slack');
    seedFreshIntegrationState('github');

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = StartSessionResult.parse(raw);

    expect(parsed.items.map((i) => i.title)).toEqual(['Older Mention', 'Newer PR']);
  });

  it('breaks score ties by occurredAtMs desc — newer row first when scores are equal', async () => {
    seedEvidence({
      integration: 'github',
      externalId: 'older',
      title: 'Older',
      kind: 'pull_request',
      occurredAtMs: FIXED_NOW - 10 * 60_000,
    });
    seedEvidence({
      integration: 'github',
      externalId: 'newer',
      title: 'Newer',
      kind: 'pull_request',
      occurredAtMs: FIXED_NOW - 1 * 60_000,
    });
    seedFreshIntegrationState('github');

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = StartSessionResult.parse(raw);

    expect(parsed.items.map((i) => i.title)).toEqual(['Newer', 'Older']);
  });

  it('breaks remaining ties by id asc — earlier insert first when score and occurredAtMs are equal', async () => {
    const idA = seedEvidence({
      integration: 'github',
      externalId: 'a',
      title: 'A',
      kind: 'pull_request',
      occurredAtMs: FIXED_NOW - FIVE_MIN,
    });
    const idB = seedEvidence({
      integration: 'github',
      externalId: 'b',
      title: 'B',
      kind: 'pull_request',
      occurredAtMs: FIXED_NOW - FIVE_MIN,
    });
    seedFreshIntegrationState('github');

    const tool = createStartSessionTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = StartSessionResult.parse(raw);

    expect(idA).toBeLessThan(idB);
    expect(parsed.items.map((i) => i.title)).toEqual(['A', 'B']);
  });
});
