// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';

describe('App (tab navigation)', () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, 'fetch', {
      value: vi.fn(async (url: string) => {
        if (url.includes('/api/stakeholders')) {
          return {
            ok: true,
            json: async () => ({
              entries: [
                { identifier: 'alice', interactions: 12, last_seen: '2026-05-21T00:00:00.000Z' },
                { identifier: 'bob', interactions: 4, last_seen: '2026-05-20T00:00:00.000Z' },
              ],
              total: 2,
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

  it('switches to the Stakeholders tab on click', async () => {
    render(<App />);
    const tab = screen.getByRole('button', { name: 'Stakeholders' });
    fireEvent.click(tab);
    expect(tab.getAttribute('aria-current')).toBe('page');
    await waitFor(() => screen.getByRole('heading', { name: 'Stakeholders' }));
  });

  it('renders the ranked stakeholder list when the API returns entries', async () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Stakeholders' }));
    const alice = await waitFor(() => screen.getByText('alice'));
    expect(alice).toBeTruthy();
    expect(screen.getByText('bob')).toBeTruthy();
  });
});
