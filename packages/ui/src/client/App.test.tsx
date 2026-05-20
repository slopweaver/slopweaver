// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';

describe('App (tab navigation)', () => {
  beforeEach(() => {
    // jsdom has no fetch; stub it for the polling effects in both tabs.
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (url: string) => {
        if (url.includes('/api/calibration')) {
          return {
            ok: true,
            json: async () => ({
              window_start: '2026-04-21T00:00:00.000Z',
              window_end: '2026-05-21T00:00:00.000Z',
              total_walks: 0,
              total_items: 0,
              acceptance_rate: 0,
              edit_rate: 0,
              rejection_rate: 0,
              daily: [],
              top_friction_tags: [],
              source_path: '/tmp/log.jsonl',
              source_present: false,
              generated_at: '2026-05-21T00:00:00.000Z',
            }),
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

  it('switches to the Calibration tab on click', async () => {
    render(<App />);
    const calTab = screen.getByRole('button', { name: 'Calibration' });
    fireEvent.click(calTab);
    expect(calTab.getAttribute('aria-current')).toBe('page');
    await waitFor(() => screen.getByRole('heading', { name: 'Calibration' }));
  });

  it('shows the empty-state copy when the log source is missing', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Calibration' }));
    const emptyState = await waitFor(() => screen.getByText(/No walk-feedback log/));
    expect(emptyState).toBeTruthy();
  });
});
