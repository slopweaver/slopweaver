// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';

describe('App (tab navigation)', () => {
  beforeEach(() => {
    // jsdom doesn't define fetch — stub it to return empty payloads so
    // the polling effects in both tabs complete cleanly.
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (url: string) => {
        if (url.includes('/api/evidence')) {
          return {
            ok: true,
            json: async () => ({ rows: [], total_in_db: 0, generated_at: new Date().toISOString() }),
          } as unknown as Response;
        }
        return {
          ok: true,
          json: async () => ({
            schemaVersion: 1,
            generatedAtMs: Date.now(),
            env: {
              node: { name: 'Node version', status: 'ok', detail: 'node x' },
              pnpm: { name: 'pnpm version', status: 'ok', detail: 'pnpm x' },
              dataDir: { name: 'Data dir', status: 'ok', detail: '/x' },
            },
            server: { host: '127.0.0.1', port: 60701, listening: true },
            integrations: [],
            mcpClients: { count: 0, transport: 'stdio', tracked: false },
          }),
        } as unknown as Response;
      }),
      writable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders the Diagnostics tab by default', async () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Diagnostics' }).getAttribute('aria-current')).toBe('page');
    await waitFor(() => screen.getByText(/Listening on/));
  });

  it('switches to the Evidence tab on click', async () => {
    render(<App />);
    const evidenceTab = screen.getByRole('button', { name: 'Evidence' });
    fireEvent.click(evidenceTab);
    expect(evidenceTab.getAttribute('aria-current')).toBe('page');
    await waitFor(() => screen.getByRole('heading', { name: 'Evidence tail' }));
  });

  it('renders both tab buttons', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Evidence' })).toBeTruthy();
  });
});
