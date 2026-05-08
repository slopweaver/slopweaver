#!/usr/bin/env node
/**
 * `slopweaver` CLI entry. With no subcommand, opens the local SQLite DB at
 * the XDG-resolved location, registers the `ping` builtin tool, and runs the
 * MCP server over stdio. The `connect <integration>` subcommand prompts for
 * a token, validates it against the upstream API, and persists it into
 * `integration_tokens` for the polling layer to consume.
 *
 * v1 ships stdio-only per decision #11. The bin is wired into MCP clients
 * via:
 *
 *   claude mcp add slopweaver -- npx -y @slopweaver/mcp-local
 *
 * After globally installing (`npm install -g @slopweaver/mcp-local`), the
 * `slopweaver` command is available directly. Run `slopweaver connect github`
 * (or `slopweaver connect slack`) to wire up an integration before launching
 * the MCP server.
 */

import { readFileSync } from 'node:fs';
import { argv, exit, stderr, stdout } from 'node:process';
import { password } from '@inquirer/prompts';
import { cac } from 'cac';
import { createDb, resolveDbPath } from '@slopweaver/db';
import { loadEnv } from '@slopweaver/env';
import { createGithubClient } from '@slopweaver/integrations-github';
import { createSlackClient } from '@slopweaver/integrations-slack';
import {
  createMcpServer,
  createPingTool,
  createStartSessionTool,
  startStdio,
} from '@slopweaver/mcp-server';
import { runConnectGithub } from './connect/github.ts';
import { runConnectSlack } from './connect/slack.ts';

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

async function runMcpServer(): Promise<void> {
  // Validate the environment before opening the SQLite file or starting the
  // server. Aggregated `EnvValidationError` propagates out and the process
  // exits non-zero — single fail-fast boundary for bad env.
  loadEnv();

  const startedAtMs = Date.now();
  const dbHandle = createDb({ path: resolveDbPath() });

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

async function runConnect(integration: string): Promise<number> {
  if (integration !== 'github' && integration !== 'slack') {
    stderr.write(`slopweaver: unknown integration "${integration}". Expected github or slack.\n`);
    return 1;
  }

  // Mirror runMcpServer's env contract — bad NODE_ENV / LOG_LEVEL must reject
  // here too, otherwise the connect path would silently honour invalid values
  // that the stdio path rejects.
  loadEnv();

  const dbHandle = createDb({ path: resolveDbPath() });
  try {
    const promptForToken = async ({ message }: { message: string }): Promise<string> =>
      password({ message, mask: true });

    if (integration === 'github') {
      return await runConnectGithub({
        db: dbHandle.db,
        promptForToken,
        validateToken: async (token: string): Promise<{ login: string }> => {
          const octokit = createGithubClient({ token });
          const { data } = await octokit.rest.users.getAuthenticated();
          return { login: data.login };
        },
        stdout,
        stderr,
      });
    }

    return await runConnectSlack({
      db: dbHandle.db,
      promptForToken,
      validateToken: async (token: string): Promise<{ team: string | null }> => {
        const slack = createSlackClient({ token });
        const auth = await slack.auth.test();
        return { team: auth.team ?? null };
      },
      stdout,
      stderr,
    });
  } finally {
    dbHandle.close();
  }
}

function asMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const cli = cac('slopweaver');

cli
  .command('connect <integration>', 'Save a token for an integration (github | slack)')
  .example('  slopweaver connect github')
  .example('  slopweaver connect slack')
  .action((integration: string) => {
    runConnect(integration)
      .then((code) => {
        exit(code);
      })
      .catch((error: unknown) => {
        stderr.write(`slopweaver: ${asMessage(error)}\n`);
        exit(1);
      });
  });

cli.command('', 'Run the MCP server over stdio (default)').action(() => {
  runMcpServer().catch((error: unknown) => {
    stderr.write(`slopweaver: ${asMessage(error)}\n`);
    exit(1);
  });
});

cli.help();
cli.version(VERSION);

// Top-level guard for synchronous parse errors (malformed argv). Async errors
// inside command actions are caught above; cac doesn't surface those here.
try {
  cli.parse(argv);
} catch (error) {
  stderr.write(`slopweaver: ${asMessage(error)}\n`);
  exit(1);
}
