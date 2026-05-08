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

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { PingResult, StartSessionResult } from '@slopweaver/contracts';
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
      expect(names).toContain('start_session');

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

      // start_session against an empty fresh DB returns the empty contract
      // shape — no integrations registered, so items/evidence/freshness are
      // all empty but `generated_at` is set.
      const startSession = await client.callTool({ name: 'start_session', arguments: {} });
      expect(startSession.isError).toBeUndefined();
      const startSessionParsed = StartSessionResult.safeParse(startSession.structuredContent);
      expect(startSessionParsed.success).toBe(true);
      if (startSessionParsed.success) {
        expect(startSessionParsed.data.items).toEqual([]);
        expect(startSessionParsed.data.evidence).toEqual([]);
        expect(startSessionParsed.data.freshness).toEqual([]);
        expect(startSessionParsed.data.generated_at.length).toBeGreaterThan(0);
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

  it('connect path enforces the same env contract as the default stdio path', () => {
    // Regression: env validation used to run only on the no-arg MCP-stdio
    // path. `slopweaver connect github` with bad env must reject before any
    // prompt, otherwise the connect path silently honours invalid env that
    // the stdio path rejects.
    const result = spawnSync(process.execPath, [cliPath, 'connect', 'github'], {
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
