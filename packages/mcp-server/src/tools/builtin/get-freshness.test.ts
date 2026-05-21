import { GetFreshnessArgs, GetFreshnessResult } from '@slopweaver/contracts';
import { createDb, integrationState } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGetFreshnessTool } from './get-freshness.ts';

const FIXED_NOW = 1_762_000_000_000;
const FIVE_MIN = 5 * 60 * 1000;
const ELEVEN_MIN = 11 * 60 * 1000;

describe('createGetFreshnessTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  function seedIntegrationState({
    integration,
    lastPollCompletedAtMs,
  }: {
    integration: string;
    lastPollCompletedAtMs: number | null;
  }) {
    dbHandle.db
      .insert(integrationState)
      .values({
        integration,
        cursor: null,
        lastPollStartedAtMs: lastPollCompletedAtMs,
        lastPollCompletedAtMs,
        createdAtMs: FIXED_NOW - ELEVEN_MIN,
        updatedAtMs: FIXED_NOW - ELEVEN_MIN,
      })
      .run();
  }

  async function callHandler(tool: ReturnType<typeof createGetFreshnessTool>, rawInput: unknown): Promise<unknown> {
    const input = GetFreshnessArgs.parse(rawInput);
    const result = await tool.handler({ input, ctx: { db: dbHandle.db } });
    if (result.isErr()) {
      throw new Error(`get_freshness handler returned Err: ${result.error.code}`);
    }
    return result.value;
  }

  it('returns an empty freshness array when integration_state is empty', async () => {
    const tool = createGetFreshnessTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = GetFreshnessResult.parse(raw);

    expect(parsed.freshness).toEqual([]);
    expect(parsed.generated_at).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('marks a row whose last poll completed within the threshold as fresh', async () => {
    seedIntegrationState({ integration: 'github', lastPollCompletedAtMs: FIXED_NOW - FIVE_MIN });

    const tool = createGetFreshnessTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = GetFreshnessResult.parse(raw);

    expect(parsed.freshness).toEqual([
      {
        integration: 'github',
        last_polled_at: new Date(FIXED_NOW - FIVE_MIN).toISOString(),
        stale: false,
      },
    ]);
  });

  it('marks a row whose last poll completed older than the threshold as stale', async () => {
    seedIntegrationState({ integration: 'slack', lastPollCompletedAtMs: FIXED_NOW - ELEVEN_MIN });

    const tool = createGetFreshnessTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = GetFreshnessResult.parse(raw);

    expect(parsed.freshness[0]).toEqual({
      integration: 'slack',
      last_polled_at: new Date(FIXED_NOW - ELEVEN_MIN).toISOString(),
      stale: true,
    });
  });

  it('marks a row whose last poll has never completed as stale with null timestamp', async () => {
    seedIntegrationState({ integration: 'github', lastPollCompletedAtMs: null });

    const tool = createGetFreshnessTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = GetFreshnessResult.parse(raw);

    expect(parsed.freshness[0]).toEqual({
      integration: 'github',
      last_polled_at: null,
      stale: true,
    });
  });

  it('honours the staleThresholdMs override', async () => {
    seedIntegrationState({ integration: 'github', lastPollCompletedAtMs: FIXED_NOW - FIVE_MIN });

    const tool = createGetFreshnessTool({
      now: () => FIXED_NOW,
      staleThresholdMs: 60 * 1000,
    });
    const raw = await callHandler(tool, {});
    const parsed = GetFreshnessResult.parse(raw);

    expect(parsed.freshness[0]?.stale).toBe(true);
  });

  it('filters out `__`-prefixed sentinel rows (e.g. `__demo__`) so they never appear in the wire response', async () => {
    // The demo seeder writes an `integration_state` row with
    // integration = '__demo__' as a label for the demo DB profile. That row
    // must not pollute the freshness output — it's not a real integration.
    seedIntegrationState({ integration: '__demo__', lastPollCompletedAtMs: FIXED_NOW - FIVE_MIN });
    seedIntegrationState({ integration: 'github', lastPollCompletedAtMs: FIXED_NOW - FIVE_MIN });

    const tool = createGetFreshnessTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = GetFreshnessResult.parse(raw);

    expect(parsed.freshness).toHaveLength(1);
    expect(parsed.freshness[0]?.integration).toBe('github');
  });

  it('returns entries sorted alphabetically by integration (deterministic across SQLite plans)', async () => {
    // Seed in reverse-alphabetical insertion order so a missing ORDER BY would
    // produce `['slack', 'github']` and fail this assertion.
    seedIntegrationState({ integration: 'slack', lastPollCompletedAtMs: null });
    seedIntegrationState({ integration: 'github', lastPollCompletedAtMs: FIXED_NOW - FIVE_MIN });

    const tool = createGetFreshnessTool({ now: () => FIXED_NOW });
    const raw = await callHandler(tool, {});
    const parsed = GetFreshnessResult.parse(raw);

    expect(parsed.freshness).toHaveLength(2);
    expect(parsed.freshness.map((f) => f.integration)).toEqual(['github', 'slack']);
  });
});
