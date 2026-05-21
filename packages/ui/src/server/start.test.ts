import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { StaticEnvChecks } from './checks.ts';
import { startUiServer, type UiServerHandle } from './start.ts';
import type { DiagnosticsResponse } from './types.ts';

const STATIC_CHECKS: StaticEnvChecks = {
  node: { name: 'Node version', status: 'ok', detail: 'node 22.10.0' },
  pnpm: { name: 'pnpm version', status: 'ok', detail: 'pnpm 10.6.1' },
  dataDir: { name: 'Data dir', status: 'ok', detail: '/tmp/x' },
};

describe('startUiServer', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let handle: UiServerHandle | undefined;
  let tempAssets: string;
  let tempCwd: string;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempAssets = mkdtempSync(join(tmpdir(), 'ui-assets-'));
    tempCwd = mkdtempSync(join(tmpdir(), 'ui-cwd-'));
    mkdirSync(join(tempAssets, 'assets'), { recursive: true });
    writeFileSync(join(tempAssets, 'index.html'), '<!doctype html><title>diag</title>');
    writeFileSync(join(tempAssets, 'assets', 'app.js'), 'console.log("hi")');
  });

  afterEach(async () => {
    if (handle) await handle.close();
    handle = undefined;
    rmSync(tempAssets, { recursive: true, force: true });
    rmSync(tempCwd, { recursive: true, force: true });
    dbHandle.close();
  });

  async function start(): Promise<UiServerHandle> {
    handle = await startUiServer({
      db: dbHandle.db,
      dataDir: '/tmp/never-used-because-staticChecks-is-injected',
      host: '127.0.0.1',
      port: 0,
      clientAssetsDir: tempAssets,
      staticChecks: STATIC_CHECKS,
      companionCwd: tempCwd,
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

  it('accepts /api/diagnostics from the Origin matching the bound port (port:0)', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/diagnostics`, {
      headers: { origin: `http://127.0.0.1:${h.address.port}` },
    });
    expect(res.status).toBe(200);
  });

  it('accepts /api/diagnostics from http://localhost:<port> (browser typing localhost)', async () => {
    const h = await start();
    const res = await fetch(`${h.url}/api/diagnostics`, {
      headers: { origin: `http://localhost:${h.address.port}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects an Origin pointing at a non-bound port', async () => {
    const h = await start();
    // The static :60701 default would have been wrongly accepted before the
    // fix; with port:0 it must be rejected because it is not the bound port.
    const res = await fetch(`${h.url}/api/diagnostics`, {
      headers: { origin: 'http://localhost:60701' },
    });
    expect(res.status).toBe(403);
    expect(h.address.port).not.toBe(60701);
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

  describe('POST /api/companion/file', () => {
    const EXTENSION_ORIGIN = 'chrome-extension://abcdef1234567890';

    it('accepts a POST from the Chrome extension and echoes the extension Origin', async () => {
      // The Chrome extension's background worker sends Origin:
      // `chrome-extension://<id>`. The companion endpoint accepts
      // *only* requests with this Origin prefix — and echoes the
      // specific origin back, never `*`. This is the P0 fix from #79
      // (iter-3): iter-1 wildcarded the response, letting any web
      // page write to the local inbox.
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ url: 'https://github.com/o/r/pull/1', title: 'PR #1' }),
      });
      expect(res.status).toBe(200);
      expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION_ORIGIN);
      expect(res.headers.get('vary')).toContain('Origin');
      const body = (await res.json()) as { filed: boolean };
      expect(body.filed).toBe(true);
    });

    it('rejects a POST from a foreign web origin with 403', async () => {
      // Any website the user visits could try `fetch('http://127.0.0.1:60701/api/companion/file', …)`.
      // The endpoint must reject the request before any inbox write
      // happens.
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ url: 'https://github.com/o/r/pull/1', title: 'PR #1' }),
      });
      expect(res.status).toBe(403);
      // Critically: no `Access-Control-Allow-Origin` for the foreign
      // origin — the browser would block the response from being read
      // anyway, but defense-in-depth.
      expect(res.headers.get('access-control-allow-origin')).toBe(null);
    });

    it('rejects a POST from the same loopback origin with 403', async () => {
      // A page served at `http://localhost:60701` (the Diagnostics UI
      // itself) must NOT be able to write to the inbox. This endpoint
      // is for the extension only.
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: `http://localhost:${h.address.port}` },
        body: JSON.stringify({ url: 'https://github.com/o/r/pull/1', title: 'PR #1' }),
      });
      expect(res.status).toBe(403);
    });

    it('rejects a POST with no Origin header with 403', async () => {
      // Extensions always send Origin from a service-worker fetch.
      // A missing Origin is either a curl-style local script or a
      // browser context that stripped the header — neither is the
      // companion. Reject.
      const h = await start();
      // node-fetch sends no Origin by default. Verify by sending an
      // explicit empty string is treated the same — easiest to do via
      // an http.request with no origin header. The default fetch()
      // call without `headers.origin` already omits it.
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: 'https://github.com/o/r/pull/1', title: 'PR #1' }),
      });
      expect(res.status).toBe(403);
    });

    it('responds to the CORS preflight OPTIONS request from the extension', async () => {
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'OPTIONS',
        headers: { origin: EXTENSION_ORIGIN },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(EXTENSION_ORIGIN);
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    });

    it('rejects an OPTIONS preflight from a foreign web origin with 403', async () => {
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example' },
      });
      expect(res.status).toBe(403);
    });

    it('rejects a javascript: URL with 400', async () => {
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ url: 'javascript:alert(1)', title: 'evil' }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { filed: boolean; error: string };
      expect(body.filed).toBe(false);
      expect(body.error).toContain('http');
    });

    it('rejects a data: URL with 400', async () => {
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ url: 'data:text/html,<script>x</script>', title: 'evil' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects a file: URL with 400', async () => {
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: JSON.stringify({ url: 'file:///etc/passwd', title: 'evil' }),
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid JSON with 400', async () => {
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: EXTENSION_ORIGIN },
        body: 'not json',
      });
      expect(res.status).toBe(400);
    });

    it('rejects GET with 405 and Allow: POST, OPTIONS', async () => {
      const h = await start();
      const res = await fetch(`${h.url}/api/companion/file`, {
        headers: { origin: EXTENSION_ORIGIN },
      });
      expect(res.status).toBe(405);
      expect(res.headers.get('allow')).toContain('POST');
    });
  });
});
