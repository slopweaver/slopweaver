/**
 * `slopweaver init` — first-run interactive wizard.
 *
 * Walks a new user from "I just installed slopweaver" to "Claude Code is
 * calling start_session against my real PRs." Composes:
 *
 *   1. Detect MCP client configs on disk (Claude Code / Cursor / Cline).
 *   2. Offer to register slopweaver in each one not yet listed.
 *   3. For each integration (github, slack):
 *        - if no token: run the existing `runConnect*` flow,
 *        - if token exists: select retest / replace / skip,
 *        - on retest or fresh connect, call `fetchIdentity` (10s timeout)
 *          to confirm the token works against the live API.
 *   4. Print a closing message suggesting "ask Claude Code about your work".
 *
 * A failed test poll is NOT fatal: the wizard prints the error and keeps
 * going. The exit code is 0 unless a connect step bailed (token persistence
 * failed, etc.) — in which case the underlying `runConnect*` already wrote
 * the error to stderr and returned 1, and we let that propagate.
 *
 * Every side effect is dependency-injected so tests can pass fakes for
 * prompts, the connect flow, the test-poll wrappers, the detect helper, and
 * the register helper without touching real stdin/filesystem/network.
 */

import type { SlopweaverDatabase } from '@slopweaver/db';
import { loadIntegrationToken } from '@slopweaver/db';
import type { BaseError, ResultAsync } from '@slopweaver/errors';
import type { RunConnectGithubDeps } from '../connect/github.ts';
import type { RunConnectSlackDeps } from '../connect/slack.ts';
import type { DetectedClient, McpClientKind } from './detect-clients.ts';
import type { InitError } from './errors.ts';

export type TestPollFn = ({
  db,
  token,
}: {
  db: SlopweaverDatabase;
  token: string;
}) => ResultAsync<unknown, BaseError | InitError>;

export type RunInitDeps = {
  db: SlopweaverDatabase;
  home: string;
  detectClients: (args: { home: string }) => Promise<DetectedClient[]>;
  registerClient: (args: {
    kind: McpClientKind;
    configPath: string;
  }) => ResultAsync<void, InitError>;
  runGithubConnect: (deps: RunConnectGithubDeps) => Promise<number>;
  runSlackConnect: (deps: RunConnectSlackDeps) => Promise<number>;
  buildGithubConnectDeps: (args: {
    db: SlopweaverDatabase;
    stdout: { write: (s: string) => void };
    stderr: { write: (s: string) => void };
  }) => RunConnectGithubDeps;
  buildSlackConnectDeps: (args: {
    db: SlopweaverDatabase;
    stdout: { write: (s: string) => void };
    stderr: { write: (s: string) => void };
  }) => RunConnectSlackDeps;
  testPollGithub: TestPollFn;
  testPollSlack: TestPollFn;
  prompt: {
    confirm: (args: { message: string; defaultValue: boolean }) => Promise<boolean>;
    selectExistingAction: (args: {
      integration: string;
      accountLabel: string | null;
    }) => Promise<'retest' | 'replace' | 'skip'>;
  };
  stdout: { write: (s: string) => void };
  stderr: { write: (s: string) => void };
};

const CLIENT_LABEL: Record<McpClientKind, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  cline: 'Cline',
};

const CLOSING_MESSAGE = `
You're all set. To try it out, ask Claude Code about your work:

  "What should I work on next?"

If something goes wrong, re-run \`slopweaver init\` to re-test or refresh a token.
`;

export async function runInit(deps: RunInitDeps): Promise<number> {
  const { stdout } = deps;

  stdout.write('SlopWeaver init\n');
  stdout.write('================\n\n');

  await stepDetectAndRegisterClients(deps);
  const githubResult = await stepConnectAndTestIntegration({
    deps,
    integration: 'github',
  });
  if (githubResult !== 0) return githubResult;

  const slackResult = await stepConnectAndTestIntegration({
    deps,
    integration: 'slack',
  });
  if (slackResult !== 0) return slackResult;

  stdout.write(CLOSING_MESSAGE);
  return 0;
}

async function stepDetectAndRegisterClients(deps: RunInitDeps): Promise<void> {
  const { detectClients, registerClient, prompt, stdout, stderr, home } = deps;

  stdout.write('Step 1: MCP client detection\n');
  const clients = await detectClients({ home });

  for (const client of clients) {
    const label = CLIENT_LABEL[client.kind];
    if (client.hasSlopweaver) {
      stdout.write(`  ✓ ${label}: slopweaver already registered (${client.configPath})\n`);
      continue;
    }
    if (client.exists) {
      stdout.write(`  - ${label}: config found but slopweaver not registered\n`);
    } else {
      stdout.write(`  - ${label}: no config found (${client.configPath})\n`);
    }

    const shouldRegister = await prompt.confirm({
      message: `Register slopweaver in ${label}?`,
      defaultValue: true,
    });
    if (!shouldRegister) {
      stdout.write(`  · ${label}: skipped\n`);
      continue;
    }

    const result = await registerClient({ kind: client.kind, configPath: client.configPath });
    if (result.isErr()) {
      stderr.write(`  ✗ ${label}: ${result.error.message}\n`);
      continue;
    }
    stdout.write(`  ✓ ${label}: registered\n`);
  }
  stdout.write('\n');
}

async function stepConnectAndTestIntegration({
  deps,
  integration,
}: {
  deps: RunInitDeps;
  integration: 'github' | 'slack';
}): Promise<number> {
  const { db, prompt, stdout, stderr } = deps;
  const headerLabel = integration === 'github' ? 'GitHub' : 'Slack';
  stdout.write(`Step ${integration === 'github' ? 2 : 3}: Connect ${headerLabel}\n`);

  const tokenResult = await loadIntegrationToken({ db, integration });
  if (tokenResult.isErr()) {
    stderr.write(
      `slopweaver: failed to read stored ${headerLabel} token: ${tokenResult.error.message}\n`,
    );
    return 1;
  }

  const existing = tokenResult.value;

  if (existing === null) {
    // Fresh path. Offer the user a chance to skip the integration entirely
    // (e.g. they only want GitHub) before we prompt for a token.
    const shouldConnect = await prompt.confirm({
      message: `Connect ${headerLabel}?`,
      defaultValue: true,
    });
    if (!shouldConnect) {
      stdout.write(`  · ${headerLabel}: skipped\n\n`);
      return 0;
    }
    const code = await runConnectFor({ deps, integration });
    if (code !== 0) return code;
  } else {
    const action = await prompt.selectExistingAction({
      integration,
      accountLabel: existing.accountLabel,
    });
    if (action === 'skip') {
      stdout.write(`  · ${headerLabel}: skipped\n\n`);
      return 0;
    }
    if (action === 'replace') {
      const code = await runConnectFor({ deps, integration });
      if (code !== 0) return code;
    }
    // 'retest' falls through to the test poll below with the existing token.
  }

  await runTestPoll({ deps, integration });
  stdout.write('\n');
  return 0;
}

async function runConnectFor({
  deps,
  integration,
}: {
  deps: RunInitDeps;
  integration: 'github' | 'slack';
}): Promise<number> {
  const { db, stdout, stderr } = deps;
  if (integration === 'github') {
    const githubDeps = deps.buildGithubConnectDeps({ db, stdout, stderr });
    return deps.runGithubConnect(githubDeps);
  }
  const slackDeps = deps.buildSlackConnectDeps({ db, stdout, stderr });
  return deps.runSlackConnect(slackDeps);
}

async function runTestPoll({
  deps,
  integration,
}: {
  deps: RunInitDeps;
  integration: 'github' | 'slack';
}): Promise<void> {
  const { db, stdout, stderr } = deps;
  const label = integration === 'github' ? 'GitHub' : 'Slack';

  const tokenResult = await loadIntegrationToken({ db, integration });
  if (tokenResult.isErr() || tokenResult.value === null) {
    // Shouldn't happen — we either just persisted a token or are in retest
    // mode where one already exists. Print and move on rather than fail the
    // wizard; the user can re-run.
    stderr.write(`  ! ${label}: skipped test poll (no token after connect)\n`);
    return;
  }

  stdout.write(`  · ${label}: verifying token...\n`);
  const pollFn = integration === 'github' ? deps.testPollGithub : deps.testPollSlack;
  const pollResult = await pollFn({ db, token: tokenResult.value.token });
  if (pollResult.isErr()) {
    stderr.write(`  ✗ ${label}: token verify failed (${pollResult.error.message})\n`);
    return;
  }
  stdout.write(`  ✓ ${label}: token verified\n`);
}
