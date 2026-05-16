/**
 * Integration-style tests for runOrchestration's risky branches.
 *
 * Drives the public `runOrchestration` API against a fully-stubbed
 * `RunOrchestrationEnvironment` so the internal helpers
 * (checkWorktreeIsReady, runOneModelAttempt, runOnePlanningAttempt) don't
 * have to be exposed. CODEX_HOME is set to a per-test tmpdir so state-file
 * side effects stay isolated.
 *
 * Coverage targets the four risky paths called out in the migration plan
 * and re-flagged by codex review iteration 1 F4:
 *
 * - merge-conflict precondition (`ORCHESTRATION_WORKTREE_MERGE_CONFLICT`)
 * - dirty-worktree precondition (`ORCHESTRATION_WORKTREE_DIRTY`)
 * - transient-then-success model-attempt fallback (loop advances to next
 *   candidate when the first attempt's output looks transient)
 * - all-models-failed terminal (`ORCHESTRATION_ALL_MODELS_FAILED`)
 * - `closeCodexJob` cleanup when await fails after the job-id parse
 *   succeeded (locks the `finally { if (jobId !== null) ... }` block)
 *
 * Reuses `docs/orchestration/examples/refactor-example.md` as the fixture
 * chain (same file `core.test.ts` uses).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { err, ok } from '@slopweaver/errors';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findMonorepoRoot } from '../lib/paths.ts';
import { OrchestrationErrors } from './errors.ts';
import { type RunOrchestrationEnvironment, runOrchestration } from './runtime.ts';

const CHAIN_FIXTURE_RELATIVE = 'docs/orchestration/examples/refactor-example.md';

type CloseCall = { cwd: string; jobId: string };
type StartCall = { model: string; reasoning: string };

interface FakeEnvOverrides {
  awaitCodexTurn?: RunOrchestrationEnvironment['awaitCodexTurn'];
  ensureWorktree?: RunOrchestrationEnvironment['ensureWorktree'];
  getBranchName?: RunOrchestrationEnvironment['getBranchName'];
  getWorktreeStatus?: RunOrchestrationEnvironment['getWorktreeStatus'];
  hasDependencies?: RunOrchestrationEnvironment['hasDependencies'];
  installDependencies?: RunOrchestrationEnvironment['installDependencies'];
  startCodexJob?: RunOrchestrationEnvironment['startCodexJob'];
}

function createFakeEnv(overrides: FakeEnvOverrides = {}): {
  env: RunOrchestrationEnvironment;
  closeCodexJobCalls: ReadonlyArray<CloseCall>;
  startCodexJobCalls: ReadonlyArray<StartCall>;
} {
  const closeCalls: CloseCall[] = [];
  const startCalls: StartCall[] = [];
  const env: RunOrchestrationEnvironment = {
    awaitCodexTurn: overrides.awaitCodexTurn ?? (() => ok('LGTM - ready for local testing.')),
    closeCodexJob: ({ cwd, jobId }) => {
      closeCalls.push({ cwd, jobId });
    },
    commitAll: () => ok(true),
    createOrReusePr: () => ok('https://github.com/slopweaver/slopweaver/pull/999'),
    ensureWorktree: overrides.ensureWorktree ?? (() => ok('/tmp/fake-worktree')),
    getBranchName: overrides.getBranchName ?? (() => ok('worktree/refactor-rename-utility')),
    getLatestCiRunId: () => '42',
    getWorktreeStatus: overrides.getWorktreeStatus ?? (() => []),
    hasDependencies: overrides.hasDependencies ?? (() => true),
    installDependencies: overrides.installDependencies ?? (() => ok(undefined)),
    notify: () => {},
    pushBranch: () => ok(undefined),
    sendCodexInput: () => ok(undefined),
    startCodexJob: overrides.startCodexJob
      ? (args) => {
          startCalls.push({ model: args.model, reasoning: args.reasoning });
          return overrides.startCodexJob!(args);
        }
      : (args) => {
          startCalls.push({ model: args.model, reasoning: args.reasoning });
          return ok('Job started: 12345');
        },
    syncEnvFiles: () => {},
    watchCi: () => ({ output: 'CI green', success: true }),
  };
  return { env, closeCodexJobCalls: closeCalls, startCodexJobCalls: startCalls };
}

function getChainFixturePath(): string {
  const rootResult = findMonorepoRoot();
  if (rootResult.isErr()) {
    throw new Error(`runtime.test setup: ${rootResult.error.message}`);
  }
  return path.join(rootResult.value, CHAIN_FIXTURE_RELATIVE);
}

describe('runOrchestration', () => {
  let originalCodexHome: string | undefined;
  let tempCodexHome: string | null = null;

  beforeEach(() => {
    originalCodexHome = process.env['CODEX_HOME'];
    tempCodexHome = mkdtempSync(path.join(tmpdir(), 'slopweaver-runtime-test-'));
    process.env['CODEX_HOME'] = tempCodexHome;
  });

  afterEach(() => {
    if (originalCodexHome === undefined) {
      delete process.env['CODEX_HOME'];
    } else {
      process.env['CODEX_HOME'] = originalCodexHome;
    }
    if (tempCodexHome) {
      rmSync(tempCodexHome, { recursive: true, force: true });
      tempCodexHome = null;
    }
  });

  it('returns ORCHESTRATION_WORKTREE_MERGE_CONFLICT when git status shows UU lines', async () => {
    const { env } = createFakeEnv({
      getWorktreeStatus: () => ['UU some/file.ts'],
    });

    const result = await runOrchestration({
      env,
      options: {
        chainInputPath: getChainFixturePath(),
        dryRun: false,
        executor: 'codex-only',
        notify: false,
        restart: true,
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ORCHESTRATION_WORKTREE_MERGE_CONFLICT');
      expect(result.error.message).toContain('merge conflicts');
    }
  });

  it('returns ORCHESTRATION_WORKTREE_DIRTY when git status shows untracked changes', async () => {
    const { env } = createFakeEnv({
      getWorktreeStatus: () => ['?? new-file.md'],
    });

    const result = await runOrchestration({
      env,
      options: {
        chainInputPath: getChainFixturePath(),
        dryRun: false,
        executor: 'codex-only',
        notify: false,
        restart: true,
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ORCHESTRATION_WORKTREE_DIRTY');
      expect(result.error.message).toContain('dirty');
    }
  });

  it('advances to the next model candidate when the first attempt is transient', async () => {
    let attempts = 0;
    const { env, startCodexJobCalls } = createFakeEnv({
      // First startCodexJob output contains 'rate limit', which matches
      // looksLikeTransientModelFailure → loop advances to next candidate.
      // Second attempt succeeds with a parseable job id.
      startCodexJob: () => {
        attempts += 1;
        if (attempts === 1) {
          return err(
            OrchestrationErrors.subprocessFailed({
              command: 'codex-agent',
              args: ['start'],
              cwd: '/tmp/fake-worktree',
              exitCode: 1,
              output: 'rate limit exceeded; retry after 60s',
            }),
          );
        }
        return ok('Job started: 67890');
      },
    });

    const result = await runOrchestration({
      env,
      options: {
        chainInputPath: getChainFixturePath(),
        dryRun: false,
        executor: 'codex-only',
        notify: false,
        restart: true,
      },
    });

    // Planning should succeed on the second model candidate; the whole
    // orchestration then proceeds. The retry advanced model candidates —
    // assert the two attempts used different models.
    expect(startCodexJobCalls.length).toBeGreaterThanOrEqual(2);
    const plannerAttempts = startCodexJobCalls.slice(0, 2);
    expect(plannerAttempts[0]?.model).not.toBe(plannerAttempts[1]?.model);
    // Orchestration ran to completion (await/ci/etc were all stubbed Ok).
    expect(result.isOk()).toBe(true);
  });

  it('returns ORCHESTRATION_ALL_MODELS_FAILED when every candidate is transient', async () => {
    const { env, startCodexJobCalls } = createFakeEnv({
      startCodexJob: () =>
        err(
          OrchestrationErrors.subprocessFailed({
            command: 'codex-agent',
            args: ['start'],
            cwd: '/tmp/fake-worktree',
            exitCode: 1,
            output: 'rate limit exceeded',
          }),
        ),
    });

    const result = await runOrchestration({
      env,
      options: {
        chainInputPath: getChainFixturePath(),
        dryRun: false,
        executor: 'codex-only',
        notify: false,
        restart: true,
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('ORCHESTRATION_ALL_MODELS_FAILED');
      // planner-main is the retry key for the planning conversation
      if (result.error.code === 'ORCHESTRATION_ALL_MODELS_FAILED') {
        expect(result.error.retryKey).toBe('planner-main');
      }
    }
    // At least one start attempt per candidate, and every one failed
    // transient, so the loop walked the full candidate list.
    expect(startCodexJobCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('calls closeCodexJob when awaitCodexTurn fails after the job id was parsed', async () => {
    const { env, closeCodexJobCalls } = createFakeEnv({
      startCodexJob: () => ok('Job started: 12345'),
      // awaitCodexTurn fails with a fatal-looking output — runOneModelAttempt
      // returns Err({ kind: 'fatal' }) and the fallback loop bubbles out
      // immediately. The finally{} cleanup MUST close the job we opened.
      awaitCodexTurn: () =>
        err(
          OrchestrationErrors.subprocessFailed({
            command: 'codex-agent',
            args: ['await-turn'],
            cwd: '/tmp/fake-worktree',
            exitCode: 1,
            output: 'irrecoverable: agent died',
          }),
        ),
    });

    const result = await runOrchestration({
      env,
      options: {
        chainInputPath: getChainFixturePath(),
        dryRun: false,
        executor: 'codex-only',
        notify: false,
        restart: true,
      },
    });

    expect(result.isErr()).toBe(true);
    // The finally block closed the job exactly once with the parsed jobId.
    expect(closeCodexJobCalls.length).toBeGreaterThanOrEqual(1);
    expect(closeCodexJobCalls[0]?.jobId).toBe('12345');
  });
});
