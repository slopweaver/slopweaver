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
 * `slopweaver` command is available directly. The recommended first run is
 * `slopweaver init` — an interactive wizard that registers slopweaver in
 * detected MCP clients and walks through connecting GitHub and Slack. The
 * lower-level `slopweaver connect github` / `slopweaver connect slack`
 * subcommands remain available for scripted setups.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { argv, cwd as processCwd, env, exit, stderr, stdout } from 'node:process';
import { confirm, password, select } from '@inquirer/prompts';
import { cac } from 'cac';
import { createDb, loadIntegrationToken, resolveDataDir, resolveDbPath } from '@slopweaver/db';
import { loadEnv } from '@slopweaver/env';
import {
  createGithubClient,
  createGithubPoller,
  fetchIdentity as fetchGithubIdentity,
  safeGithubCall,
} from '@slopweaver/integrations-github';
import { errAsync } from '@slopweaver/errors';
import {
  createSlackClient,
  createSlackPoller,
  fetchIdentity as fetchSlackIdentity,
  safeSlackCall,
} from '@slopweaver/integrations-slack';
import {
  createCatchMeUpTool,
  createGetFreshnessTool,
  createMcpServer,
  createPingTool,
  createSearchWorkContextTool,
  createStartSessionTool,
  type StartSessionPoller,
  startStdio,
} from '@slopweaver/mcp-server';
import { DEFAULT_PORT as UI_DEFAULT_PORT, startUiServer, type UiServerHandle } from '@slopweaver/ui';
import { runConnectGithub } from './connect/github.ts';
import { runConnectSlack } from './connect/slack.ts';
import { detectClients } from './init/detect-clients.ts';
import { registerClient } from './init/register-client.ts';
import { runInit } from './init/index.ts';
import { withTimeout } from './init/with-timeout.ts';

// Read the bin's own version from its package.json at runtime. dist/cli.js
// sits one directory below package.json (apps/mcp-local/package.json in the
// workspace, node_modules/@slopweaver/mcp-local/package.json once
// installed), so `../package.json` resolves the same way in both layouts.
function readVersion(): string {
  const packageJsonUrl = new URL('../package.json', import.meta.url);
  const raw: unknown = JSON.parse(readFileSync(packageJsonUrl, 'utf-8'));
  if (typeof raw !== 'object' || raw === null || !('version' in raw) || typeof raw.version !== 'string') {
    throw new Error('package.json must define a string `version`');
  }
  return (raw as { version: string }).version;
}

const VERSION = readVersion();

function resolveWebUiPort(): number {
  const raw = env['SLOPWEAVER_WEB_UI_PORT'];
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

  // Load connected integration tokens from `integration_tokens` in parallel,
  // then build a poller map keyed by integration slug to pass into the
  // composite `start_session` tool. `null` means "not connected — skip";
  // `Err` is a real DB failure and propagates via the same if-isErr-throw
  // CLI-boundary pattern as the env/dbPath/dataDir results above.
  const [githubTokenResult, slackTokenResult] = await Promise.all([
    loadIntegrationToken({ db: dbHandle.db, integration: 'github' }),
    loadIntegrationToken({ db: dbHandle.db, integration: 'slack' }),
  ]);
  if (githubTokenResult.isErr()) {
    throw githubTokenResult.error;
  }
  if (slackTokenResult.isErr()) {
    throw slackTokenResult.error;
  }

  const pollers: Record<string, StartSessionPoller> = {};

  const githubToken = githubTokenResult.value;
  if (githubToken !== null) {
    // fetchIdentity validates the token against the live API and refreshes
    // identity_graph. A revoked PAT, network blip, or rate-limit response
    // must not abort startup: log and omit github from the pollers map so
    // start_session keeps serving slack + cached evidence. The user can
    // `slopweaver connect github` again later without a restart-relevant
    // state change. Mirrors the EADDRINUSE fail-soft below.
    const identityResult = await fetchGithubIdentity({
      db: dbHandle.db,
      token: githubToken.token,
    });
    if (identityResult.isErr()) {
      stderr.write(
        `slopweaver: failed to resolve GitHub identity, skipping live polling: ${identityResult.error.message}\n`,
      );
    } else {
      pollers['github'] = createGithubPoller({
        token: githubToken.token,
        username: identityResult.value.username,
      });
    }
  }

  const slackToken = slackTokenResult.value;
  if (slackToken !== null) {
    // Slack's createSlackPoller is network-free; the poller calls
    // `auth.test()` internally on first invocation. No pre-validation needed
    // here because there's no analogous pre-resolved field to capture
    // (mentions/DMs both work from the token alone).
    pollers['slack'] = createSlackPoller({ token: slackToken.token });
  }

  const server = createMcpServer({
    db: dbHandle.db,
    version: VERSION,
    tools: [
      createPingTool({ version: VERSION, startedAtMs }),
      createStartSessionTool({ pollers }),
      createGetFreshnessTool(),
      createCatchMeUpTool(),
      createSearchWorkContextTool(),
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
        stderr.write(`slopweaver: port ${uiPort} in use; web UI disabled (pass --no-web-ui to silence)\n`);
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

const INIT_TEST_POLL_TIMEOUT_MS = 10_000;

async function runInitCmd(): Promise<number> {
  // Mirror runConnect's env contract. A bad NODE_ENV / LOG_LEVEL must reject
  // here too so init can't silently honour invalid values.
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

    return await runInit({
      db: dbHandle.db,
      home: homedir(),
      cwd: processCwd(),
      // Respect $CLINE_DIR when set so the wizard probes / writes to the same
      // path the user's actual Cline install uses. Empty string is treated as
      // "not set" — same as undefined — because shells often export blank
      // variables that should be ignored.
      clineDir: env['CLINE_DIR'] !== undefined && env['CLINE_DIR'].length > 0 ? env['CLINE_DIR'] : undefined,
      detectClients,
      registerClient,
      runGithubConnect: runConnectGithub,
      runSlackConnect: runConnectSlack,
      buildGithubConnectDeps: ({ db, stdout: childStdout, stderr: childStderr }) => ({
        db,
        promptForToken,
        validateToken: ({ token }: { token: string }) => {
          const octokit = createGithubClient({ token });
          return safeGithubCall({
            execute: () => octokit.rest.users.getAuthenticated(),
            endpoint: 'users.getAuthenticated',
          }).map((res) => ({ login: res.data.login }));
        },
        stdout: childStdout,
        stderr: childStderr,
      }),
      buildSlackConnectDeps: ({ db, stdout: childStdout, stderr: childStderr }) => ({
        db,
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
        stdout: childStdout,
        stderr: childStderr,
      }),
      testPollGithub: ({ db, token }) =>
        withTimeout({
          operation: fetchGithubIdentity({ db, token }),
          timeoutMs: INIT_TEST_POLL_TIMEOUT_MS,
        }),
      testPollSlack: ({ db, token }) =>
        withTimeout({
          operation: fetchSlackIdentity({ db, token }),
          timeoutMs: INIT_TEST_POLL_TIMEOUT_MS,
        }),
      prompt: {
        confirm: ({ message, defaultValue }) => confirm({ message, default: defaultValue }),
        selectExistingAction: ({ integration, accountLabel }) => {
          const label = integration === 'github' ? 'GitHub' : 'Slack';
          const accountHint = accountLabel === null ? '' : ` (${accountLabel})`;
          return select<'retest' | 'replace' | 'skip'>({
            message: `${label} is already connected${accountHint}. What now?`,
            choices: [
              { name: 'Re-test the existing token', value: 'retest' },
              { name: 'Replace with a new token', value: 'replace' },
              { name: 'Skip', value: 'skip' },
            ],
            default: 'retest',
          });
        },
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
    const message = error.message;
    if (typeof message === 'string') return message;
  }
  return String(error);
}

const cli = cac('slopweaver');

cli
  .command('init', 'First-run interactive wizard: register slopweaver in MCP clients and connect integrations')
  .example('  slopweaver init')
  .action(async () => {
    try {
      const code = await runInitCmd();
      exit(code);
    } catch (error: unknown) {
      stderr.write(`slopweaver: ${asMessage({ error })}\n`);
      exit(1);
    }
  });

cli
  .command('connect <integration>', 'Save a token for an integration (github | slack)')
  .example('  slopweaver connect github')
  .example('  slopweaver connect slack')
  .action(async (integration: string) => {
    try {
      const code = await runConnect({ integration });
      exit(code);
    } catch (error: unknown) {
      stderr.write(`slopweaver: ${asMessage({ error })}\n`);
      exit(1);
    }
  });

cli
  .command('walk', 'Print the ranked /lock-in walk queue from the local reconciliation file')
  .example('  slopweaver walk')
  .action(async () => {
    try {
      const { runWalk } = await import('./walk/index.ts');
      const code = await runWalk({ cwd: processCwd(), stdout, stderr });
      exit(code);
    } catch (error: unknown) {
      stderr.write(`slopweaver: ${asMessage({ error })}\n`);
      exit(1);
    }
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
