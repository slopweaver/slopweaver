import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StaticEnvChecks } from './checks.ts';
import { startWebUiServer, type WebUiServerHandle } from './start.ts';
import type { DiagnosticsResponse } from './types.ts';

const STATIC_CHECKS: StaticEnvChecks = {
  node: { name: 'Node version', status: 'ok', detail: 'node 22.10.0' },
  pnpm: { name: 'pnpm version', status: 'ok', detail: 'pnpm 10.6.1' },
  dataDir: { name: 'Data dir', status: 'ok', detail: '/tmp/x' },
};

describe('startWebUiServer', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let handle: WebUiServerHandle | undefined;
  let tempAssets: string;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempAssets = mkdtempSync(join(tmpdir(), 'web-ui-assets-'));
    mkdirSync(join(tempAssets, 'assets'), { recursive: true });
    writeFileSync(join(tempAssets, 'index.html'), '<!doctype html><title>diag</title>');
    writeFileSync(join(tempAssets, 'assets', 'app.js'), 'console.log("hi")');
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
    rmSync(tempAssets, { recursive: true, force: true });
    dbHandle.close();
  });

  async function start(): Promise<WebUiServerHandle> {
    handle = await startWebUiServer({
      db: dbHandle.db,
      dataDir: '/tmp/never-used-because-staticChecks-is-injected',
      host: '127.0.0.1',
      port: 0,
      clientAssetsDir: tempAssets,
      staticChecks: STATIC_CHECKS,
    });
    return handle;
  }

  it('responds to GET /api/diagnostics with the typed JSON shape', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/diagnostics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    const body = (await res.json()) as DiagnosticsResponse;
    expect(body.schemaVersion).toBe(1);
    expect(body.env.node.status).toBe('ok');
    expect(body.server.host).toBe('127.0.0.1');
    expect(body.server.port).toBe(h.address.port);
    expect(body.integrations).toEqual([]);
    expect(body.mcpClients).toEqual({ count: 1, transport: 'stdio', tracked: false });
  });

  it('rejects /api/diagnostics with a foreign Origin', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/diagnostics`, {
      headers: { origin: 'http://evil.example' },
    });
    expect(res.status).toBe(403);
  });

  it('accepts /api/diagnostics from http://localhost:60701', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/diagnostics`, {
      headers: { origin: 'http://localhost:60701' },
    });
    expect(res.status).toBe(200);
  });

  it('returns 405 for POST /api/diagnostics', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/diagnostics`, { method: 'POST' });
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('returns 404 for unknown /api/* routes', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/unknown`);
    expect(res.status).toBe(404);
  });

  it('serves index.html at /', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(await res.text()).toContain('<title>diag</title>');
  });

  it('serves bundled assets', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/assets/app.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toContain('hi');
  });

  it('falls back to index.html for unknown extensionless routes (SPA)', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/some-future-page`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('returns 404 for unknown asset files', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/missing.js`);
    expect(res.status).toBe(404);
  });

  it('does not leak files outside the assets dir for /../-style paths', async () => {
    const h = await start();
    // The URL parser strips `..` segments before our static-serve logic runs;
    // anything left after normalization either matches a real asset, 404s, or
    // falls through to the SPA index.html. The defense-in-depth guard in
    // serveStatic catches the (unreachable today, but cheap) case where a
    // literal `..` survives parsing.
    const res = await fetch(`${h.url}/../etc/passwd`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('<title>diag</title>');
    expect(body).not.toMatch(/root:[^:]*:0:0/);
  });

  it('reports the actual port in the response when port:0 is requested', async () => {
    const h = await start();
    expect(h.address.port).toBeGreaterThan(0);
    const res = await fetch(`${h.url}/api/diagnostics`);
    const body = (await res.json()) as DiagnosticsResponse;
    expect(body.server.port).toBe(h.address.port);
  });
});
