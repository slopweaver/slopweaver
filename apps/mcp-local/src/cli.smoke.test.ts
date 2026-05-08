/**
 * End-to-end smoke test for the published `slopweaver` binary.
 *
 * Spawns the compiled `dist/cli.js` via `StdioClientTransport` (which uses
 * `child_process.spawn` under the hood), drives the real MCP wire protocol
 * over the child's stdio, and asserts that `tools/list` advertises `ping`
 * and that `tools/call ping` returns the v1 PingResult shape.
 *
 * This catches packaging regressions that the in-memory test in
 * `@slopweaver/mcp-server` cannot — package wiring, the shebang round-trip
 * through tsc, the Drizzle migrations folder shipped by `@slopweaver/db`,
 * and better-sqlite3 native module resolution from the published layout.
 *
 * `XDG_DATA_HOME` is repointed at a per-test tmp dir so the SQLite file
 * never lands in the developer's real `~/.slopweaver/`.
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PingResult } from '@slopweaver/contracts';
import type { DiagnosticsResponse } from '@slopweaver/web-ui';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, '../dist/cli.js');

describe('slopweaver bin (compiled CLI)', () => {
  let dataHome: string;

  beforeEach(() => {
    dataHome = mkdtempSync(resolve(tmpdir(), 'slopweaver-smoke-'));
  });

  afterEach(() => {
    rmSync(dataHome, { recursive: true, force: true });
  });

  it('has a compiled dist/cli.js (chmod +x is set by npm at install time)', () => {
    const stat = statSync(cliPath);
    expect(stat.isFile()).toBe(true);
  });

  it('advertises ping over stdio and returns a valid PingResult on tools/call', async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath],
      // Inherit PATH etc. but override the data dir so we don't touch the
      // user's real ~/.slopweaver. `XDG_DATA_HOME` is honoured by
      // `resolveDataDir()` in @slopweaver/db.
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
      },
      stderr: 'pipe',
    });

    const client = new Client({ name: 'slopweaver-smoke', version: '0.0.0' });
    await client.connect(transport);

    try {
      const list = await client.listTools();
      const names = list.tools.map((t) => t.name);
      expect(names).toContain('ping');

      const ping = list.tools.find((t) => t.name === 'ping');
      expect(ping?.inputSchema.type).toBe('object');

      const callResult = await client.callTool({ name: 'ping', arguments: {} });
      expect(callResult.isError).toBeUndefined();

      const parsed = PingResult.safeParse(callResult.structuredContent);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.ok).toBe(true);
        expect(parsed.data.version.length).toBeGreaterThan(0);
        expect(parsed.data.uptime_s).toBeGreaterThanOrEqual(0);
      }
    } finally {
      await client.close();
    }
  });

  it('exits non-zero with a clean stderr message when env is invalid', () => {
    const result = spawnSync(process.execPath, [cliPath], {
      env: {
        PATH: process.env.PATH ?? '',
        XDG_DATA_HOME: dataHome,
        NODE_ENV: 'banana',
        LOG_LEVEL: 'shout',
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('slopweaver:');
    expect(result.stderr).toContain('NODE_ENV');
    expect(result.stderr).toContain('LOG_LEVEL');
    // No stack trace lines ("    at <frame>") — startup errors print only
    // the aggregated message.
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });

  it('exits non-zero with a clean stderr message when XDG_DATA_HOME is relative', () => {
    const result = spawnSync(process.execPath, [cliPath], {
      env: {
        PATH: process.env.PATH ?? '',
        XDG_DATA_HOME: 'tmp/relative',
      },
      encoding: 'utf-8',
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('slopweaver:');
    expect(result.stderr).toContain('XDG_DATA_HOME must be an absolute path');
    expect(result.stderr).not.toMatch(/^\s+at /m);
  });
});

describe('slopweaver bin web UI', () => {
  let dataHome: string;

  beforeEach(() => {
    dataHome = mkdtempSync(resolve(tmpdir(), 'slopweaver-smoke-webui-'));
  });

  afterEach(() => {
    rmSync(dataHome, { recursive: true, force: true });
  });

  it('starts the Diagnostics web UI on a random port and serves /api/diagnostics', async () => {
    // SLOPWEAVER_WEB_UI_PORT=0 lets the OS pick a free port — robust against
    // dev environments where 60701 is in use. The bound URL is logged to
    // stderr; we scrape it to discover the actual port.
    const child = spawn(process.execPath, [cliPath], {
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        SLOPWEAVER_WEB_UI_PORT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrBuf: string[] = [];
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf.push(chunk);
    });

    try {
      const url = await waitForWebUiUrl(stderrBuf, 10_000);
      const res = await fetch(`${url}/api/diagnostics`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toContain('application/json');
      const body = (await res.json()) as DiagnosticsResponse;
      expect(body.schemaVersion).toBe(1);
      expect(body.server.host).toBe('127.0.0.1');
      expect(body.server.listening).toBe(true);
      expect(body.integrations).toEqual([]);
      expect(body.mcpClients).toEqual({ count: 1, transport: 'stdio', tracked: false });
      expect(body.env.node.status).toBe('ok');
    } finally {
      await terminate(child);
    }
  });

  it('--no-web-ui suppresses the web UI', async () => {
    const child = spawn(process.execPath, [cliPath, '--no-web-ui'], {
      env: {
        ...process.env,
        XDG_DATA_HOME: dataHome,
        SLOPWEAVER_WEB_UI_PORT: '0',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stderrBuf: string[] = [];
    child.stderr.setEncoding('utf-8');
    child.stderr.on('data', (chunk: string) => {
      stderrBuf.push(chunk);
    });

    try {
      // Wait for the explicit "suppressed" line — confirms the binary reached
      // the post-flag-parse branch and intentionally skipped the web UI.
      // Deterministic vs. a fixed sleep: passes only after a real signal.
      await waitForStderrMatch(stderrBuf, /web UI suppressed by --no-web-ui/, 10_000);
      expect(child.exitCode).toBeNull();
      expect(stderrBuf.join('')).not.toContain('web UI on');
    } finally {
      await terminate(child);
    }
  });
});

async function waitForWebUiUrl(stderrBuf: string[], timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const all = stderrBuf.join('');
    const match = all.match(/web UI on (http:\/\/[^\s]+)/);
    if (match?.[1] !== undefined) return match[1];
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  throw new Error(
    `web UI did not advertise a URL within ${timeoutMs}ms; stderr=${stderrBuf.join('')}`,
  );
}

async function waitForStderrMatch(
  stderrBuf: string[],
  pattern: RegExp,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pattern.test(stderrBuf.join(''))) return;
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  throw new Error(
    `stderr did not match ${pattern} within ${timeoutMs}ms; stderr=${stderrBuf.join('')}`,
  );
}

async function terminate(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolveExit) => {
    child.once('exit', () => resolveExit());
  });
}
