/**
 * Unit tests for runInit. The wizard composes many collaborators (detect,
 * register, connect-github, connect-slack, test-poll-github, test-poll-slack,
 * prompts), so the test DI surface is correspondingly wide — but each fake
 * is a single closure. No `vi.mock` needed. Real in-memory DB so the token
 * persistence side-effects are observable end-to-end.
 *
 * Covers the four acceptance-criteria scenarios from issue #39:
 *   1. Fresh install (no tokens, no configs registered)
 *   2. Re-init with existing tokens (retest one, skip the other)
 *   3. User skips Slack entirely
 *   4. Test poll fails gracefully (wizard still returns 0)
 */

import { createDb, loadIntegrationToken, saveIntegrationToken } from '@slopweaver/db';
import { errAsync, okAsync } from '@slopweaver/errors';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RunConnectGithubDeps } from '../connect/github.ts';
import { runConnectGithub } from '../connect/github.ts';
import type { RunConnectSlackDeps } from '../connect/slack.ts';
import { runConnectSlack } from '../connect/slack.ts';
import { runInit, type RunInitDeps } from './index.ts';

type Buf = { write: (s: string) => void; text: () => string };

function makeBuf(): Buf {
  const chunks: string[] = [];
  return {
    write: (s) => {
      chunks.push(s);
    },
    text: () => chunks.join(''),
  };
}

function defaultDeps({
  db,
  overrides = {},
}: {
  db: ReturnType<typeof createDb>['db'];
  overrides?: Partial<RunInitDeps>;
}): { deps: RunInitDeps; stdout: Buf; stderr: Buf } {
  const stdout = makeBuf();
  const stderr = makeBuf();

  const deps: RunInitDeps = {
    db,
    home: '/tmp/fake-home-not-used',
    cwd: '/tmp/fake-cwd-not-used',
    clineDir: undefined,
    detectClients: vi.fn().mockResolvedValue([]),
    registerClient: vi.fn().mockReturnValue(okAsync(undefined)),
    runGithubConnect: vi.fn(async (d: RunConnectGithubDeps) => runConnectGithub(d)),
    runSlackConnect: vi.fn(async (d: RunConnectSlackDeps) => runConnectSlack(d)),
    buildGithubConnectDeps: ({ db: innerDb, stdout: innerStdout, stderr: innerStderr }) => ({
      db: innerDb,
      promptForToken: async () => 'ghp_happy',
      validateToken: () => okAsync({ login: 'octocat' }),
      stdout: innerStdout,
      stderr: innerStderr,
    }),
    buildSlackConnectDeps: ({ db: innerDb, stdout: innerStdout, stderr: innerStderr }) => ({
      db: innerDb,
      promptForToken: async () => 'xoxp-happy',
      validateToken: () => okAsync({ team: 'AcmeCorp' }),
      stdout: innerStdout,
      stderr: innerStderr,
    }),
    testPollGithub: () => okAsync({ username: 'octocat' }),
    testPollSlack: () => okAsync({ team: 'AcmeCorp' }),
    prompt: {
      confirm: vi.fn().mockResolvedValue(true),
      selectExistingAction: vi.fn().mockResolvedValue('retest'),
    },
    stdout,
    stderr,
    ...overrides,
  };

  return { deps, stdout, stderr };
}

describe('runInit', () => {
  let handle: ReturnType<typeof createDb>;

  beforeEach(() => {
    handle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    handle.close();
  });

  it('fresh install: detects clients, registers in detected ones, connects both integrations, verifies tokens', async () => {
    const detectClients = vi.fn().mockResolvedValue([
      {
        kind: 'claude-code',
        variant: 'home',
        configPath: '/h/.claude.json',
        exists: false,
        hasSlopweaver: false,
      },
      {
        kind: 'cursor',
        variant: 'home',
        configPath: '/h/.cursor/mcp.json',
        exists: false,
        hasSlopweaver: false,
      },
      {
        kind: 'cline',
        variant: 'home',
        configPath: '/h/.cline/x.json',
        exists: false,
        hasSlopweaver: false,
      },
    ]);
    const registerClient = vi.fn().mockReturnValue(okAsync(undefined));

    const { deps, stdout, stderr } = defaultDeps({
      db: handle.db,
      overrides: { detectClients, registerClient },
    });

    const code = await runInit(deps);

    expect(code).toBe(0);
    expect(registerClient).toHaveBeenCalledTimes(3);
    expect(stdout.text()).toContain('ask Claude Code about your work');
    expect(stderr.text()).toBe('');

    const githubLoaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    const slackLoaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(githubLoaded.isOk() && githubLoaded.value).toEqual({
      token: 'ghp_happy',
      accountLabel: 'octocat',
    });
    expect(slackLoaded.isOk() && slackLoaded.value).toEqual({
      token: 'xoxp-happy',
      accountLabel: 'AcmeCorp',
    });
  });

  it('re-init with existing tokens: user picks skip for github, retest for slack', async () => {
    // Pre-seed both rows.
    await saveIntegrationToken({
      db: handle.db,
      integration: 'github',
      token: 'ghp_existing',
      accountLabel: 'octocat',
    });
    await saveIntegrationToken({
      db: handle.db,
      integration: 'slack',
      token: 'xoxp-existing',
      accountLabel: 'AcmeCorp',
    });

    const runGithubConnect = vi.fn().mockResolvedValue(0);
    const testPollGithub = vi.fn().mockReturnValue(okAsync({}));
    const testPollSlack = vi.fn().mockReturnValue(okAsync({}));

    const selectExistingAction = vi
      .fn()
      .mockImplementation(({ integration }) =>
        integration === 'github' ? Promise.resolve('skip') : Promise.resolve('retest'),
      );

    const { deps, stdout } = defaultDeps({
      db: handle.db,
      overrides: {
        runGithubConnect,
        testPollGithub,
        testPollSlack,
        prompt: {
          confirm: vi.fn().mockResolvedValue(true),
          selectExistingAction,
        },
      },
    });

    const code = await runInit(deps);

    expect(code).toBe(0);
    expect(runGithubConnect).not.toHaveBeenCalled();
    expect(testPollGithub).not.toHaveBeenCalled();
    expect(testPollSlack).toHaveBeenCalledTimes(1);
    expect(stdout.text()).toContain('GitHub: skipped');
    expect(stdout.text()).toContain('Slack: token verified');

    // Existing tokens must not have been overwritten.
    const githubLoaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    expect(githubLoaded.isOk() && githubLoaded.value?.token).toBe('ghp_existing');
  });

  it('user skips Slack entirely on fresh install: only GitHub is connected', async () => {
    // confirm returns:
    //   - 'Register slopweaver in <client>?' (none detected, so no calls) — not triggered
    //   - 'Connect GitHub?' → true
    //   - 'Connect Slack?' → false
    const confirm = vi
      .fn()
      .mockImplementation(({ message }) => Promise.resolve(!String(message).includes('Slack')));

    const { deps, stdout } = defaultDeps({
      db: handle.db,
      overrides: {
        prompt: {
          confirm,
          selectExistingAction: vi.fn().mockResolvedValue('skip'),
        },
      },
    });

    const code = await runInit(deps);

    expect(code).toBe(0);
    expect(stdout.text()).toContain('Slack: skipped');
    const slackLoaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(slackLoaded.isOk() && slackLoaded.value).toBeNull();
    const githubLoaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    expect(githubLoaded.isOk() && githubLoaded.value?.token).toBe('ghp_happy');
  });

  it('test poll fails: wizard prints the error and still exits 0', async () => {
    const testPollGithub = vi
      .fn()
      .mockReturnValue(errAsync({ code: 'GITHUB_API_ERROR', message: 'rate limited' }));

    const { deps, stdout, stderr } = defaultDeps({
      db: handle.db,
      overrides: { testPollGithub },
    });

    const code = await runInit(deps);

    expect(code).toBe(0);
    expect(stderr.text()).toContain('GitHub: token verify failed');
    expect(stderr.text()).toContain('rate limited');
    // Wizard still printed the closing message after the failure.
    expect(stdout.text()).toContain('ask Claude Code about your work');
    // GitHub token persistence still succeeded — the test poll failure is
    // post-persistence, so the row exists.
    const githubLoaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    expect(githubLoaded.isOk() && githubLoaded.value?.token).toBe('ghp_happy');
  });

  it('skips registration of clients that already list slopweaver', async () => {
    const detectClients = vi.fn().mockResolvedValue([
      {
        kind: 'claude-code',
        variant: 'home',
        configPath: '/h/.claude.json',
        exists: true,
        hasSlopweaver: true,
      },
      {
        kind: 'cursor',
        variant: 'home',
        configPath: '/h/.cursor/mcp.json',
        exists: false,
        hasSlopweaver: false,
      },
      {
        kind: 'cline',
        variant: 'home',
        configPath: '/h/.cline/x.json',
        exists: false,
        hasSlopweaver: false,
      },
    ]);
    const registerClient = vi.fn().mockReturnValue(okAsync(undefined));

    const { deps, stdout } = defaultDeps({
      db: handle.db,
      overrides: { detectClients, registerClient },
    });

    await runInit(deps);

    expect(registerClient).toHaveBeenCalledTimes(2);
    expect(stdout.text()).toContain('Claude Code: slopweaver already registered');
  });

  // P1 #3 fix: registration failure must suppress the success banner.
  it('registration failure: suppresses "you\'re all set" and prints the partial-setup banner', async () => {
    const detectClients = vi.fn().mockResolvedValue([
      {
        kind: 'claude-code',
        variant: 'home',
        configPath: '/h/.claude.json',
        exists: true,
        hasSlopweaver: false,
      },
    ]);
    // claude mcp add returned non-zero — registerClient surfaces the error.
    const registerClient = vi.fn().mockReturnValue(
      errAsync({
        code: 'INIT_CLAUDE_MCP_ADD_FAILED',
        message: '`claude mcp add slopweaver` exited 2: auth required',
        exitCode: 2,
        stderr: 'auth required',
      }),
    );

    const { deps, stdout, stderr } = defaultDeps({
      db: handle.db,
      overrides: { detectClients, registerClient },
    });

    const code = await runInit(deps);

    expect(code).toBe(0); // wizard didn't crash, but…
    expect(stderr.text()).toContain('auth required');
    // Success banner suppressed — the "ask Claude Code about your work" line
    // would be a lie when registration just failed.
    expect(stdout.text()).not.toContain('ask Claude Code about your work');
    // Partial-setup banner is what the user should see instead.
    expect(stdout.text()).toContain('Setup completed with some issues');
  });

  // P2: replace branch was not covered. Pin it now.
  it("re-init: user picks 'replace' on existing GitHub token → runConnect runs and overwrites", async () => {
    await saveIntegrationToken({
      db: handle.db,
      integration: 'github',
      token: 'ghp_old',
      accountLabel: 'octocat',
    });

    const runGithubConnect = vi.fn(async (d: RunConnectGithubDeps) => runConnectGithub(d));
    const selectExistingAction = vi.fn().mockImplementation(({ integration }) =>
      // replace for github, skip slack so the test focuses on github
      Promise.resolve(integration === 'github' ? 'replace' : 'skip'),
    );

    const { deps } = defaultDeps({
      db: handle.db,
      overrides: {
        runGithubConnect,
        buildGithubConnectDeps: ({ db: innerDb, stdout: s, stderr: e }) => ({
          db: innerDb,
          promptForToken: async () => 'ghp_new',
          validateToken: () => okAsync({ login: 'octocat-renamed' }),
          stdout: s,
          stderr: e,
        }),
        prompt: {
          confirm: vi.fn().mockResolvedValue(true),
          selectExistingAction,
        },
      },
    });

    const code = await runInit(deps);
    expect(code).toBe(0);

    expect(runGithubConnect).toHaveBeenCalledTimes(1);
    const githubLoaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    expect(githubLoaded.isOk() && githubLoaded.value).toEqual({
      token: 'ghp_new',
      accountLabel: 'octocat-renamed',
    });
  });

  // P2: partial prior setup — one integration connected, one missing.
  it('partial prior setup: GitHub already connected, Slack fresh → only Slack runs connect', async () => {
    await saveIntegrationToken({
      db: handle.db,
      integration: 'github',
      token: 'ghp_existing',
      accountLabel: 'octocat',
    });

    const runGithubConnect = vi.fn().mockResolvedValue(0);
    const runSlackConnect = vi.fn(async (d: RunConnectSlackDeps) => runConnectSlack(d));
    const selectExistingAction = vi.fn().mockResolvedValue('retest');

    const { deps } = defaultDeps({
      db: handle.db,
      overrides: {
        runGithubConnect,
        runSlackConnect,
        prompt: {
          confirm: vi.fn().mockResolvedValue(true),
          selectExistingAction,
        },
      },
    });

    const code = await runInit(deps);
    expect(code).toBe(0);

    expect(runGithubConnect).not.toHaveBeenCalled(); // retest, not replace
    expect(runSlackConnect).toHaveBeenCalledTimes(1); // slack: fresh, ran
    // Both tokens are present at the end.
    const githubLoaded = await loadIntegrationToken({ db: handle.db, integration: 'github' });
    const slackLoaded = await loadIntegrationToken({ db: handle.db, integration: 'slack' });
    expect(githubLoaded.isOk() && githubLoaded.value?.token).toBe('ghp_existing');
    expect(slackLoaded.isOk() && slackLoaded.value?.token).toBe('xoxp-happy');
  });

  // P2: idempotency after successful `claude mcp add`. The first run hands off
  // to the claude CLI (no local file write); the second run must detect the
  // already-registered entry via hasSlopweaver: true and NOT call register again.
  it('idempotency: re-run after successful claude mcp add detects already-registered and skips', async () => {
    // First run: clients all unregistered, claude mcp add succeeds.
    const detectFirstRun = vi.fn().mockResolvedValue([
      {
        kind: 'claude-code',
        variant: 'home',
        configPath: '/h/.claude.json',
        exists: false,
        hasSlopweaver: false,
      },
    ]);
    const registerClient = vi.fn().mockReturnValue(okAsync(undefined));

    const { deps: depsRun1 } = defaultDeps({
      db: handle.db,
      overrides: { detectClients: detectFirstRun, registerClient },
    });
    await runInit(depsRun1);
    expect(registerClient).toHaveBeenCalledTimes(1);

    // Second run: same client now hasSlopweaver: true. registerClient must NOT
    // be called again.
    registerClient.mockClear();
    const detectSecondRun = vi.fn().mockResolvedValue([
      {
        kind: 'claude-code',
        variant: 'home',
        configPath: '/h/.claude.json',
        exists: true,
        hasSlopweaver: true,
      },
    ]);
    const { deps: depsRun2, stdout: stdoutRun2 } = defaultDeps({
      db: handle.db,
      overrides: {
        detectClients: detectSecondRun,
        registerClient,
        prompt: {
          confirm: vi.fn().mockResolvedValue(true),
          // Both integrations now have tokens (from run 1); test passes 'skip'
          // so we focus on the registration-already-detected behaviour.
          selectExistingAction: vi.fn().mockResolvedValue('skip'),
        },
      },
    });
    await runInit(depsRun2);

    expect(registerClient).not.toHaveBeenCalled();
    expect(stdoutRun2.text()).toContain('Claude Code: slopweaver already registered');
  });
});
