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

import type { KeychainAdapter, SlopweaverDatabase } from '@slopweaver/db';
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
  cwd: string;
  clineDir: string | undefined;
  detectClients: (args: { home: string; cwd: string; clineDir: string | undefined }) => Promise<DetectedClient[]>;
  registerClient: (args: { kind: McpClientKind; configPath: string }) => ResultAsync<void, InitError>;
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
  /** Inject in tests so token reads/writes hit an in-memory store, not the OS keychain. Defaults to the real adapter inside `loadIntegrationToken`/`saveIntegrationToken`. */
  keychainAdapter?: KeychainAdapter;
};

const CLIENT_KIND_LABEL: Record<McpClientKind, string> = {
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
  cline: 'Cline',
};

function labelFor(client: DetectedClient): string {
  const base = CLIENT_KIND_LABEL[client.kind];
  switch (client.variant) {
    case 'home':
      // No suffix when there's no ambiguity. Adding "(home)" to claude-code
      // would just be noise since claude-code only has one variant.
      return base;
    case 'project':
      return `${base} (project: ${client.configPath})`;
    case 'env-override':
      return `${base} ($CLINE_DIR override: ${client.configPath})`;
  }
}

const SUCCESS_CLOSING = `
You're all set. To try it out, ask Claude Code about your work:

  "What should I work on next?"

If something goes wrong, re-run \`slopweaver init\` to re-test or refresh a token.
`;

const PARTIAL_CLOSING = `
Setup completed with some issues — see the messages above. Re-run \`slopweaver init\`
after resolving the failures (e.g. fix a malformed MCP config, install the \`claude\`
CLI, or rerun \`slopweaver connect\` for a failing token).
`;

export async function runInit(deps: RunInitDeps): Promise<number> {
  const { stdout } = deps;

  stdout.write('SlopWeaver init\n');
  stdout.write('================\n\n');

  const registrationOk = await stepDetectAndRegisterClients(deps);
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

  // P1 #3 fix: if any registration attempt failed (claude mcp add returned
  // non-zero, a JSON config was malformed and we refused to overwrite, etc.),
  // do NOT print the "you're all set" success banner. The wizard already
  // logged each failure to stderr; surface the partial-setup message so the
  // user knows to fix the underlying issue before trying start_session.
  stdout.write(registrationOk ? SUCCESS_CLOSING : PARTIAL_CLOSING);
  return 0;
}

/**
 * Returns `true` iff every requested registration succeeded (or was skipped
 * by the user). `false` means at least one registration failed for a reason
 * other than user-declined, so the wizard should suppress its success banner.
 */
async function stepDetectAndRegisterClients(deps: RunInitDeps): Promise<boolean> {
  const { detectClients, registerClient, prompt, stdout, stderr, home, cwd, clineDir } = deps;

  stdout.write('Step 1: MCP client detection\n');
  const clients = await detectClients({ home, cwd, clineDir });

  let allRegistrationsOk = true;
  for (const client of clients) {
    const label = labelFor(client);
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
      allRegistrationsOk = false;
      continue;
    }
    stdout.write(`  ✓ ${label}: registered\n`);
  }
  stdout.write('\n');
  return allRegistrationsOk;
}

async function stepConnectAndTestIntegration({
  deps,
  integration,
}: {
  deps: RunInitDeps;
  integration: 'github' | 'slack';
}): Promise<number> {
  const { db, prompt, stdout, stderr, keychainAdapter } = deps;
  const headerLabel = integration === 'github' ? 'GitHub' : 'Slack';
  stdout.write(`Step ${integration === 'github' ? 2 : 3}: Connect ${headerLabel}\n`);

  const tokenResult = await loadIntegrationToken({
    db,
    integration,
    ...(keychainAdapter ? { keychainAdapter } : {}),
  });
  if (tokenResult.isErr()) {
    stderr.write(`slopweaver: failed to read stored ${headerLabel} token: ${tokenResult.error.message}\n`);
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
  const { db, stdout, stderr, keychainAdapter } = deps;
  if (integration === 'github') {
    const githubDeps: RunConnectGithubDeps = {
      ...deps.buildGithubConnectDeps({ db, stdout, stderr }),
      ...(keychainAdapter ? { keychainAdapter } : {}),
    };
    return deps.runGithubConnect(githubDeps);
  }
  const slackDeps: RunConnectSlackDeps = {
    ...deps.buildSlackConnectDeps({ db, stdout, stderr }),
    ...(keychainAdapter ? { keychainAdapter } : {}),
  };
  return deps.runSlackConnect(slackDeps);
}

async function runTestPoll({
  deps,
  integration,
}: {
  deps: RunInitDeps;
  integration: 'github' | 'slack';
}): Promise<void> {
  const { db, stdout, stderr, keychainAdapter } = deps;
  const label = integration === 'github' ? 'GitHub' : 'Slack';

  const tokenResult = await loadIntegrationToken({
    db,
    integration,
    ...(keychainAdapter ? { keychainAdapter } : {}),
  });
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
