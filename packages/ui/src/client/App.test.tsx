// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.tsx';

describe('App (tab navigation)', () => {
  beforeEach(() => {
    // jsdom doesn't define fetch. Stub it to return empty payloads so
    // the polling effects in every tab complete cleanly. Use
    // `vi.stubGlobal` so `vi.unstubAllGlobals()` in afterEach restores
    // the original (undefined) value and doesn't leak the stub into
    // subsequent test files. Matches the pattern in Diagnostics.test.tsx.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/evidence')) {
          return {
            ok: true,
            json: async () => ({ rows: [], total_in_db: 0, generated_at: new Date().toISOString() }),
          } as unknown as Response;
        }
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
              by_integration: [],
              by_kind: [],
              top_friction_tags: [],
              source_path: '/tmp/log.jsonl',
              source_present: false,
              empty: true,
              generated_at: '2026-05-21T00:00:00.000Z',
            }),
          } as unknown as Response;
        }
        if (url.includes('/api/stakeholders')) {
          return {
            ok: true,
            json: async () => ({
              entries: [
                { identifier: 'alice', interactions: 12, last_seen: '2026-05-21T00:00:00.000Z' },
                { identifier: 'bob', interactions: 4, last_seen: '2026-05-20T00:00:00.000Z' },
              ],
              total: 2,
              unattributed_count: 0,
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
    );
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
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

  it('switches to the Calibration tab on click', async () => {
    render(<App />);
    const calTab = screen.getByRole('button', { name: 'Calibration' });
    fireEvent.click(calTab);
    expect(calTab.getAttribute('aria-current')).toBe('page');
    await waitFor(() => screen.getByRole('heading', { name: 'Calibration' }));
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

  it('renders all four tab buttons', () => {
    render(<App />);
    expect(screen.getByRole('button', { name: 'Diagnostics' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Evidence' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Calibration' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Stakeholders' })).toBeTruthy();
  });
});
