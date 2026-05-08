import { createDb, integrationState } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StaticEnvChecks } from './checks.ts';
import { buildDiagnosticsResponse } from './diagnostics.ts';

const NOW_MS = 1_700_000_000_000;

const STATIC_CHECKS: StaticEnvChecks = {
  node: { name: 'Node version', status: 'ok', detail: 'node 22.10.0 (>=22)' },
  pnpm: { name: 'pnpm version', status: 'ok', detail: 'pnpm 10.6.1 (>=10)' },
  dataDir: { name: 'Data dir', status: 'ok', detail: '/tmp/x (writable)' },
};

const BIND = { host: '127.0.0.1', port: 60701 };

describe('buildDiagnosticsResponse', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('returns schemaVersion 1 with empty integrations when the table is empty', () => {
    const result = buildDiagnosticsResponse({
      db: dbHandle.db,
      staticChecks: STATIC_CHECKS,
      bindAddress: BIND,
      nowMs: NOW_MS,
    });
    expect(result.schemaVersion).toBe(1);
    expect(result.generatedAtMs).toBe(NOW_MS);
    expect(result.integrations).toEqual([]);
    expect(result.env).toEqual(STATIC_CHECKS);
    expect(result.server).toEqual({ host: '127.0.0.1', port: 60701, listening: true });
    expect(result.mcpClients).toEqual({ count: 1, transport: 'stdio', tracked: false });
  });

  it('marks integrations stale when last_poll_completed is older than 10 minutes', () => {
    const tenMinPlus = NOW_MS - 10 * 60 * 1000 - 1;
    const fresh = NOW_MS - 60_000;
    dbHandle.db
      .insert(integrationState)
      .values([
        {
          integration: 'github',
          cursor: null,
          lastPollStartedAtMs: fresh,
          lastPollCompletedAtMs: fresh,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
        },
        {
          integration: 'slack',
          cursor: null,
          lastPollStartedAtMs: tenMinPlus,
          lastPollCompletedAtMs: tenMinPlus,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
        },
        {
          integration: 'jira',
          cursor: null,
          lastPollStartedAtMs: NOW_MS,
          lastPollCompletedAtMs: null,
          createdAtMs: NOW_MS,
          updatedAtMs: NOW_MS,
        },
      ])
      .run();

    const result = buildDiagnosticsResponse({
      db: dbHandle.db,
      staticChecks: STATIC_CHECKS,
      bindAddress: BIND,
      nowMs: NOW_MS,
    });
    const byName = Object.fromEntries(result.integrations.map((i) => [i.integration, i]));
    expect(byName['github']).toMatchObject({ stale: false, lastError: null });
    expect(byName['slack']).toMatchObject({ stale: true, lastError: null });
    expect(byName['jira']).toMatchObject({ stale: true, lastError: null });
  });

  it('always reports lastError as null in v1', () => {
    dbHandle.db
      .insert(integrationState)
      .values({
        integration: 'github',
        cursor: null,
        lastPollStartedAtMs: NOW_MS,
        lastPollCompletedAtMs: NOW_MS,
        createdAtMs: NOW_MS,
        updatedAtMs: NOW_MS,
      })
      .run();
    const result = buildDiagnosticsResponse({
      db: dbHandle.db,
      staticChecks: STATIC_CHECKS,
      bindAddress: BIND,
      nowMs: NOW_MS,
    });
    expect(result.integrations[0]?.lastError).toBeNull();
  });
});
