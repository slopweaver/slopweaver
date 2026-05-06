#!/usr/bin/env node
/**
 * `slopweaver` CLI entry. Parses minimal args (`--version`, `--help`),
 * otherwise opens the local SQLite DB at the XDG-resolved location, registers
 * the `ping` builtin tool, and runs the MCP server over stdio.
 *
 * v1 ships stdio-only per decision #11. The bin is wired into MCP clients
 * via:
 *
 *   claude mcp add slopweaver -- npx -y @slopweaver/mcp-local
 *
 * After globally installing (`npm install -g @slopweaver/mcp-local`), the
 * `slopweaver` command is available directly. Out of scope for this app:
 * `init`, `doctor`, `connect` subcommands and the localhost web UI — those
 * land in subsequent issues.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { createDb, resolveDbPath } from '@slopweaver/db';
import { loadEnv } from '@slopweaver/env';
import { createMcpServer, createPingTool, startStdio } from '@slopweaver/mcp-server';

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
  -v, --version   Print the version and exit.
  -h, --help      Show this message.

Wire into Claude Code:
  claude mcp add slopweaver -- npx -y @slopweaver/mcp-local

For other clients see the README:
  https://github.com/slopweaver/slopweaver
`;

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

  // Validate the environment before opening the SQLite file or starting the
  // server. Aggregated `EnvValidationError` propagates out and the process
  // exits non-zero — single fail-fast boundary for bad env.
  loadEnv();

  const startedAtMs = Date.now();
  const dbHandle = createDb({ path: resolveDbPath() });

  const server = createMcpServer({
    db: dbHandle.db,
    version: VERSION,
    tools: [createPingTool({ version: VERSION, startedAtMs })],
  });

  // Ensure the SQLite handle is closed on graceful shutdown. The MCP
  // transport keeps the event loop alive, so this is the only path that
  // releases the file lock cleanly. SIGINT comes from Ctrl-C in a terminal;
  // SIGTERM is what well-behaved MCP clients send when shutting the server
  // down.
  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      await server.close();
    } catch (error) {
      stderr.write(`slopweaver: error closing MCP server on ${signal}: ${String(error)}\n`);
    }
    try {
      dbHandle.close();
    } catch (error) {
      stderr.write(`slopweaver: error closing database on ${signal}: ${String(error)}\n`);
    }
    exit(0);
  };

  process.on('SIGINT', (signal) => {
    void shutdown(signal);
  });
  process.on('SIGTERM', (signal) => {
    void shutdown(signal);
  });

  await startStdio({ server });
}

await main();
