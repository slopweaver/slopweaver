// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DiagnosticsResponse } from '../../server/types.ts';
import { Diagnostics } from './Diagnostics.tsx';

const HEALTHY: DiagnosticsResponse = {
  schemaVersion: 1,
  generatedAtMs: 1_700_000_000_000,
  env: {
    node: { name: 'Node version', status: 'ok', detail: 'node 22.10.0 (>=22)' },
    pnpm: { name: 'pnpm version', status: 'ok', detail: 'pnpm 10.6.1 (>=10)' },
    dataDir: { name: 'Data dir', status: 'ok', detail: '/home/u/.slopweaver (writable)' },
  },
  server: { host: '127.0.0.1', port: 60701, listening: true },
  integrations: [
    {
      integration: 'github',
      lastPollStartedAtMs: 1_700_000_000_000,
      lastPollCompletedAtMs: 1_700_000_000_000,
      stale: false,
      lastError: null,
    },
  ],
  mcpClients: { count: 1, transport: 'stdio', tracked: false },
};

const DEGRADED: DiagnosticsResponse = {
  ...HEALTHY,
  env: {
    ...HEALTHY.env,
    dataDir: { name: 'Data dir', status: 'warn', detail: '/home/u/.slopweaver (missing)' },
  },
  integrations: [
    {
      integration: 'slack',
      lastPollStartedAtMs: 1_699_999_400_000,
      lastPollCompletedAtMs: 1_699_999_400_000,
      stale: true,
      lastError: null,
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('Diagnostics page', () => {
  it('renders a healthy response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(HEALTHY))),
    );
    render(<Diagnostics />);
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: /SlopWeaver Diagnostics/i })).toBeTruthy();
    });
    await screen.findByText(/node 22\.10\.0/);
    expect(screen.getByText(/github/)).toBeTruthy();
    expect(screen.getAllByText(/^fresh$/i).length).toBeGreaterThan(0);
  });

  it('renders the stale badge for degraded integrations', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse(DEGRADED))),
    );
    render(<Diagnostics />);
    await waitFor(() => screen.getByText(/missing/i));
    expect(screen.getByText(/^stale$/i)).toBeTruthy();
  });

  it('renders an error banner on fetch failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('boom'))),
    );
    render(<Diagnostics />);
    await waitFor(() => screen.getByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('boom');
  });
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}
