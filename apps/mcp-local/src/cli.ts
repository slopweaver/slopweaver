#!/usr/bin/env node
/**
 * `slopweaver` CLI entry. Parses minimal args (`--version`, `--help`,
 * `--no-web-ui`), opens the local SQLite DB at the XDG-resolved location,
 * registers the `ping` builtin tool, runs the MCP server over stdio, and
 * (unless suppressed) starts the local Diagnostics web UI on
 * `http://127.0.0.1:60701`.
 *
 * v1 ships stdio as the primary surface per decision #11. The bin is wired
 * into MCP clients via:
 *
 *   claude mcp add slopweaver -- npx -y @slopweaver/mcp-local
 *
 * After globally installing (`npm install -g @slopweaver/mcp-local`), the
 * `slopweaver` command is available directly. Out of scope for this app:
 * `init`, `doctor`, `connect` subcommands — those land in subsequent issues.
 */

import { readFileSync } from 'node:fs';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { createDb, resolveDataDir, resolveDbPath } from '@slopweaver/db';
import { loadEnv } from '@slopweaver/env';
import {
  createMcpServer,
  createPingTool,
  createStartSessionTool,
  startStdio,
} from '@slopweaver/mcp-server';
import {
  DEFAULT_PORT as UI_DEFAULT_PORT,
  startUiServer,
  type UiServerHandle,
} from '@slopweaver/ui';

// Read the bin's own version from its package.json at runtime. dist/cli.js
// sits one directory below package.json (apps/mcp-local/package.json in the
// workspace, node_modules/@slopweaver/mcp-local/package.json once
// installed), so `../package.json` resolves the same way in both layouts.
function readVersion(): string {
  const packageJsonUrl = new URL('../package.json', import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(packageJsonUrl, 'utf-8'));
  if (
    typeof raw !== 'object' ||
    raw === null ||
    !('version' in raw) ||
    typeof (raw as { version: unknown }).version !== 'string'
  ) {
    throw new Error('package.json must define a string `version`');
  }
  return (raw as { version: string }).version;
}

const VERSION = readVersion();

const HELP = `slopweaver — local MCP server (v${VERSION}).

Usage:
  slopweaver [options]

With no arguments, runs an MCP server over stdio. The server is intended to
be spawned by an MCP client (Claude Code, Cursor, Cline, Codex CLI). It is
not interactive when launched directly from a terminal.

Options:
  -v, --version    Print the version and exit.
  -h, --help       Show this message.
      --no-web-ui  Disable the local Diagnostics web UI on 127.0.0.1:60701.

Environment:
  SLOPWEAVER_WEB_UI_PORT   Override the web UI port (default 60701; 0 = pick).

Wire into Claude Code:
  claude mcp add slopweaver -- npx -y @slopweaver/mcp-local

For other clients see the README:
  https://github.com/slopweaver/slopweaver
`;

function resolveWebUiPort(): number {
  const raw = env.SLOPWEAVER_WEB_UI_PORT;
  if (raw === undefined || raw === '') return UI_DEFAULT_PORT;
  // Strict-digit gate: `Number.parseInt` would silently accept `"60701junk"`
  // → 60701. Reject any non-digit characters so misconfigured envs fail loudly.
  if (!/^\d+$/.test(raw)) {
    throw new Error(`SLOPWEAVER_WEB_UI_PORT must be an integer in [0, 65535]; got: "${raw}"`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (parsed > 65_535) {
    throw new Error(`SLOPWEAVER_WEB_UI_PORT must be an integer in [0, 65535]; got: "${raw}"`);
  }
  return parsed;
}

async function main(): Promise<void> {
  const args = new Set(argv.slice(2));

  if (args.has('--version') || args.has('-v')) {
    stdout.write(`${VERSION}\n`);
    return;
  }

  if (args.has('--help') || args.has('-h')) {
    stdout.write(HELP);
    return;
  }

  const uiEnabled = !args.has('--no-web-ui');

  // Validate the environment before opening the SQLite file or starting the
  // server. Aggregated `EnvValidationError` propagates out and the process
  // exits non-zero — single fail-fast boundary for bad env.
  loadEnv();

  const startedAtMs = Date.now();
  const dbHandle = createDb({ path: resolveDbPath() });
  const dataDir = resolveDataDir();

  const server = createMcpServer({
    db: dbHandle.db,
    version: VERSION,
    tools: [
      createPingTool({ version: VERSION, startedAtMs }),
      // Pollers are intentionally empty in v1: integration auth tokens are
      // not yet wired through env, so `force_refresh` is a no-op until that
      // lands. The tool still serves cached evidence and accurate freshness
      // reports without them.
      createStartSessionTool(),
    ],
  });

  // Start the local Diagnostics web UI (default ON). EADDRINUSE is non-fatal:
  // typically means another slopweaver instance is already serving the page,
  // and stdio (the primary surface) is unaffected. Other failures propagate.
  // Resolve the port lazily so a malformed `SLOPWEAVER_WEB_UI_PORT` doesn't
  // abort the binary when the user has explicitly disabled the web UI.
  let uiHandle: UiServerHandle | undefined;
  if (uiEnabled) {
    const uiPort = resolveWebUiPort();
    try {
      uiHandle = await startUiServer({
        db: dbHandle.db,
        dataDir,
        port: uiPort,
      });
      stderr.write(`slopweaver: web UI on ${uiHandle.url}\n`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        stderr.write(
          `slopweaver: port ${uiPort} in use; web UI disabled (pass --no-web-ui to silence)\n`,
        );
      } else {
        throw error;
      }
    }
  } else {
    // Explicit log so callers (and the smoke test) can observe that the web
    // UI start path was reached and intentionally skipped, not silently dead.
    stderr.write('slopweaver: web UI suppressed by --no-web-ui flag\n');
  }

  // Ensure the SQLite handle is closed on graceful shutdown. The MCP
  // transport keeps the event loop alive, so this is the only path that
  // releases the file lock cleanly. SIGINT comes from Ctrl-C in a terminal;
  // SIGTERM is what well-behaved MCP clients send when shutting the server
  // down.
  let shuttingDown = false;
  const shutdown = async ({ signal }: { signal: NodeJS.Signals }): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch (error) {
      stderr.write(`slopweaver: error closing MCP server on ${signal}: ${String(error)}\n`);
    }
    if (uiHandle !== undefined) {
      try {
        await uiHandle.close();
      } catch (error) {
        stderr.write(`slopweaver: error closing web UI on ${signal}: ${String(error)}\n`);
      }
    }
    try {
      dbHandle.close();
    } catch (error) {
      stderr.write(`slopweaver: error closing database on ${signal}: ${String(error)}\n`);
    }
    exit(0);
  };

  process.on('SIGINT', (signal) => {
    void shutdown({ signal });
  });
  process.on('SIGTERM', (signal) => {
    void shutdown({ signal });
  });

  await startStdio({ server });
}

// Top-level guard: any error thrown during startup (env validation,
// XDG path validation, DB open, transport setup) is a "won't start"
// condition. Print just the message to stderr and exit non-zero — end
// users don't need a stack trace for "your config is wrong".
try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  stderr.write(`slopweaver: ${message}\n`);
  exit(1);
}
