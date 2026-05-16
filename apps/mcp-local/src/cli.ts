#!/usr/bin/env node
/**
 * `slopweaver` CLI entry. With no subcommand, opens the local SQLite DB at
 * the XDG-resolved location, registers the `ping` + `start_session` builtin
 * tools, runs the MCP server over stdio, and (unless `--no-web-ui` is set)
 * starts the local Diagnostics web UI on `http://127.0.0.1:60701`. The
 * `connect <integration>` subcommand prompts for a token, validates it
 * against the upstream API, and persists it into `integration_tokens` for
 * the polling layer to consume.
 *
 * v1 ships stdio as the primary surface per decision #11. The bin is wired
 * into MCP clients via:
 *
 *   claude mcp add slopweaver -- npx -y @slopweaver/mcp-local
 *
 * After globally installing (`npm install -g @slopweaver/mcp-local`), the
 * `slopweaver` command is available directly. Run `slopweaver connect github`
 * (or `slopweaver connect slack`) to wire up an integration before launching
 * the MCP server.
 */

import { readFileSync } from 'node:fs';
import { argv, env, exit, stderr, stdout } from 'node:process';
import { password } from '@inquirer/prompts';
import { cac } from 'cac';
import { createDb, resolveDataDir, resolveDbPath } from '@slopweaver/db';
import { loadEnv } from '@slopweaver/env';
import { createGithubClient, safeGithubCall } from '@slopweaver/integrations-github';
import { errAsync } from '@slopweaver/errors';
import { createSlackClient, safeSlackCall } from '@slopweaver/integrations-slack';
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

async function runMcpServer({ uiEnabled }: { uiEnabled: boolean }): Promise<void> {
  // Validate the environment before opening the SQLite file or starting the
  // server. The `EnvValidationError` is unwrapped at this CLI boundary so the
  // outer .catch() in the cac action prints + exits non-zero.
  const envResult = loadEnv();
  if (envResult.isErr()) {
    throw envResult.error;
  }

  const dbPathResult = resolveDbPath();
  if (dbPathResult.isErr()) {
    throw dbPathResult.error;
  }
  const dataDirResult = resolveDataDir();
  if (dataDirResult.isErr()) {
    throw dataDirResult.error;
  }

  const startedAtMs = Date.now();
  const dbHandle = createDb({ path: dbPathResult.value });
  const dataDir = dataDirResult.value;

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

async function runConnect({ integration }: { integration: string }): Promise<number> {
  if (integration !== 'github' && integration !== 'slack') {
    stderr.write(`slopweaver: unknown integration "${integration}". Expected github or slack.\n`);
    return 1;
  }

  // Mirror runMcpServer's env contract — bad NODE_ENV / LOG_LEVEL must reject
  // here too, otherwise the connect path would silently honour invalid values
  // that the stdio path rejects.
  const envResult = loadEnv();
  if (envResult.isErr()) {
    throw envResult.error;
  }

  const dbPathResult = resolveDbPath();
  if (dbPathResult.isErr()) {
    throw dbPathResult.error;
  }

  const dbHandle = createDb({ path: dbPathResult.value });
  try {
    const promptForToken = async ({ message }: { message: string }): Promise<string> =>
      password({ message, mask: true });

    if (integration === 'github') {
      return await runConnectGithub({
        db: dbHandle.db,
        promptForToken,
        validateToken: ({ token }: { token: string }) => {
          const octokit = createGithubClient({ token });
          return safeGithubCall({
            execute: () => octokit.rest.users.getAuthenticated(),
            endpoint: 'users.getAuthenticated',
          }).map((res) => ({ login: res.data.login }));
        },
        stdout,
        stderr,
      });
    }

    return await runConnectSlack({
      db: dbHandle.db,
      promptForToken,
      validateToken: ({ token }: { token: string }) => {
        const slackResult = createSlackClient({ token });
        if (slackResult.isErr()) {
          return errAsync(slackResult.error);
        }
        const slack = slackResult.value;
        return safeSlackCall({
          execute: () => slack.auth.test(),
          endpoint: 'auth.test',
        }).map((auth) => ({ team: auth.team ?? null }));
      },
      stdout,
      stderr,
    });
  } finally {
    dbHandle.close();
  }
}

function asMessage({ error }: { error: unknown }): string {
  // Native Error instances expose `.message` directly. Result-pattern errors
  // (BaseError-shaped plain objects from @slopweaver/errors) also carry a
  // string `message` field — extract it explicitly so they print cleanly at
  // this CLI boundary instead of stringifying to `[object Object]`.
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null && 'message' in error) {
    const message = (error as { message: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

const cli = cac('slopweaver');

cli
  .command('connect <integration>', 'Save a token for an integration (github | slack)')
  .example('  slopweaver connect github')
  .example('  slopweaver connect slack')
  .action((integration: string) => {
    runConnect({ integration })
      .then((code) => {
        exit(code);
      })
      .catch((error: unknown) => {
        stderr.write(`slopweaver: ${asMessage({ error })}\n`);
        exit(1);
      });
  });

cli
  .command('', 'Run the MCP server over stdio (default)')
  .option('--no-web-ui', 'Disable the local Diagnostics web UI on 127.0.0.1:60701')
  .action((options: { webUi: boolean }) => {
    runMcpServer({ uiEnabled: options.webUi }).catch((error: unknown) => {
      stderr.write(`slopweaver: ${asMessage({ error })}\n`);
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
  stderr.write(`slopweaver: ${asMessage({ error })}\n`);
  exit(1);
}
