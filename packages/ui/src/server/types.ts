/**
 * Wire types for the Diagnostics page response.
 *
 * Shared between the Node-side `buildDiagnosticsResponse` and the browser-side
 * fetch wrapper. Plain TS — no Zod parsing on the wire. Keep this file
 * dependency-free so the client bundle can import it without pulling Node
 * deps into the browser bundle.
 */

export type EnvCheckStatus = 'ok' | 'warn' | 'fail';

export type EnvCheck = {
  name: string;
  status: EnvCheckStatus;
  detail: string;
};

export type IntegrationStatus = {
  integration: string;
  lastPollStartedAtMs: number | null;
  lastPollCompletedAtMs: number | null;
  /** True when the most recent successful poll is older than {@link STALE_THRESHOLD_MS} or has never happened. */
  stale: boolean;
  /**
   * Always null in v1: `integration_state` has no `last_error` column yet.
   * Reserved here so adding the column is a non-breaking change for the page.
   */
  lastError: string | null;
};

export type DiagnosticsResponse = {
  schemaVersion: 1;
  generatedAtMs: number;
  env: {
    node: EnvCheck;
    pnpm: EnvCheck;
    dataDir: EnvCheck;
  };
  server: {
    host: string;
    port: number;
    listening: true;
  };
  integrations: IntegrationStatus[];
  mcpClients: {
    count: number;
    transport: 'stdio';
    /** False until `@slopweaver/mcp-server` exposes connection lifecycle hooks. */
    tracked: false;
  };
};

export const STALE_THRESHOLD_MS = 10 * 60 * 1000;
