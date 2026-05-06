import type { SlopweaverDatabase } from '@slopweaver/db';
import { integrationState } from '@slopweaver/db';
import type { StaticEnvChecks } from './checks.ts';
import type { DiagnosticsResponse, IntegrationStatus } from './types.ts';
import { STALE_THRESHOLD_MS } from './types.ts';

export type BuildDiagnosticsArgs = {
  db: SlopweaverDatabase;
  staticChecks: StaticEnvChecks;
  bindAddress: { host: string; port: number };
  /** Override `Date.now()` for tests. */
  nowMs?: number;
};

export function buildDiagnosticsResponse({
  db,
  staticChecks,
  bindAddress,
  nowMs = Date.now(),
}: BuildDiagnosticsArgs): DiagnosticsResponse {
  const rows = db
    .select({
      integration: integrationState.integration,
      lastPollStartedAtMs: integrationState.lastPollStartedAtMs,
      lastPollCompletedAtMs: integrationState.lastPollCompletedAtMs,
    })
    .from(integrationState)
    .all();

  return {
    schemaVersion: 1,
    generatedAtMs: nowMs,
    env: staticChecks,
    server: { host: bindAddress.host, port: bindAddress.port, listening: true },
    integrations: rows.map((row) => toIntegrationStatus(row, nowMs)),
    mcpClients: { count: 1, transport: 'stdio', tracked: false },
  };
}

function toIntegrationStatus(
  row: {
    integration: string;
    lastPollStartedAtMs: number | null;
    lastPollCompletedAtMs: number | null;
  },
  nowMs: number,
): IntegrationStatus {
  const completed = row.lastPollCompletedAtMs;
  const stale = completed === null || nowMs - completed > STALE_THRESHOLD_MS;
  return {
    integration: row.integration,
    lastPollStartedAtMs: row.lastPollStartedAtMs,
    lastPollCompletedAtMs: row.lastPollCompletedAtMs,
    stale,
    lastError: null,
  };
}
