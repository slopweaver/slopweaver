/**
 * Git branch enforcement for the AI work console.
 *
 * The work console always lives on a dedicated branch — `ai-work-console`
 * by default — so it never mixes with PR-branch work. This module owns
 * the `git` subprocess dance: detect the repo root, check the current
 * branch, switch (or create-then-switch) to the work-console branch.
 *
 * Subprocess invocation is injected via `gitRunner` so tests don't need
 * a real git binary. The default runner uses `node:child_process` `spawn`.
 */

import { spawn } from 'node:child_process';
import { ResultAsync, errAsync, okAsync } from '@slopweaver/errors';
import { type WorkConsoleConfig } from './config.ts';
import { type WorkConsoleError, WorkConsoleErrors } from './errors.ts';

export type GitRunResult = {
  exitCode: number | null;
  stdout: string;
  stderr: string;
};

/**
 * Async runner: receives positional git args + a cwd, returns the result.
 * Default implementation uses `spawn` with no shell.
 */
export type GitRunner = (args: { argv: ReadonlyArray<string>; cwd: string }) => Promise<GitRunResult>;

export const defaultGitRunner: GitRunner = ({ argv, cwd }) =>
  new Promise<GitRunResult>((resolve) => {
    const child = spawn('git', [...argv], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('close', (exitCode) => {
      resolve({ exitCode, stdout, stderr });
    });
    child.on('error', (e) => {
      resolve({ exitCode: null, stdout, stderr: stderr || (e instanceof Error ? e.message : String(e)) });
    });
  });

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function run(runner: GitRunner, cwd: string, argv: ReadonlyArray<string>): ResultAsync<GitRunResult, WorkConsoleError> {
  return ResultAsync.fromPromise(runner({ argv, cwd }), (e) =>
    WorkConsoleErrors.gitFailed(argv.join(' '), null, describeError(e)),
  ).andThen((result) => {
    if (result.exitCode === 0) return okAsync(result);
    return errAsync(WorkConsoleErrors.gitFailed(argv.join(' '), result.exitCode, result.stderr));
  });
}

function tryRun(
  runner: GitRunner,
  cwd: string,
  argv: ReadonlyArray<string>,
): ResultAsync<GitRunResult, WorkConsoleError> {
  // Same as run but doesn't error on non-zero exit — used for queries.
  return ResultAsync.fromPromise(runner({ argv, cwd }), (e) =>
    WorkConsoleErrors.gitFailed(argv.join(' '), null, describeError(e)),
  );
}

export type EnsureBranchResult = {
  action: 'already_on_branch' | 'switched' | 'created_and_switched' | 'no_git_repo';
  branch: string;
  repoRoot: string;
  message?: string;
};

/**
 * Ensure the user is on the work-console branch. If they're not in a git
 * repo, returns `action: 'no_git_repo'` (not an error — slopweaver still
 * works for a user who installs into a non-git directory, just without
 * the branch isolation guarantee).
 *
 * Behavior matrix:
 * - Not a git repo → `no_git_repo`.
 * - Already on the branch → `already_on_branch`.
 * - On a different branch with no uncommitted changes → `switched`.
 * - On a different branch with uncommitted changes → DirtyWorktreeError
 *   unless `allowSwitchWithUncommitted: true` (we then `git stash push -u`
 *   before switching).
 * - Branch doesn't exist yet → create from current HEAD, then switch
 *   (`created_and_switched`).
 */
export function ensureWorkConsoleBranch(args: {
  config: WorkConsoleConfig;
  runner?: GitRunner;
  allowSwitchWithUncommitted?: boolean;
}): ResultAsync<EnsureBranchResult, WorkConsoleError> {
  const runner = args.runner ?? defaultGitRunner;
  const { branch, cwd } = args.config;
  const allowSwitchWithUncommitted = args.allowSwitchWithUncommitted ?? false;

  return tryRun(runner, cwd, ['rev-parse', '--show-toplevel']).andThen<EnsureBranchResult, WorkConsoleError>(
    (toplevel) => {
      if (toplevel.exitCode !== 0) {
        return okAsync({
          action: 'no_git_repo',
          branch,
          repoRoot: cwd,
          message: toplevel.stderr.trim() || 'not a git repository',
        });
      }
      const repoRoot = toplevel.stdout.trim();
      return run(runner, repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).andThen<EnsureBranchResult, WorkConsoleError>(
        (headResult) => {
          const currentBranch = headResult.stdout.trim();
          if (currentBranch === branch) {
            return okAsync({
              action: 'already_on_branch',
              branch,
              repoRoot,
            });
          }
          return tryRun(runner, repoRoot, ['status', '--porcelain']).andThen<EnsureBranchResult, WorkConsoleError>(
            (statusResult) => {
              const dirty = statusResult.stdout.trim().length > 0;
              if (dirty && !allowSwitchWithUncommitted) {
                return errAsync(WorkConsoleErrors.dirtyWorktree(branch, statusResult.stdout));
              }
              const stashPromise: ResultAsync<GitRunResult, WorkConsoleError> = dirty
                ? run(runner, repoRoot, ['stash', 'push', '-u', '-m', `slopweaver: ensure ${branch}`])
                : okAsync({ exitCode: 0, stdout: '', stderr: '' });
              return stashPromise.andThen<EnsureBranchResult, WorkConsoleError>(() =>
                tryRun(runner, repoRoot, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`]).andThen<
                  EnsureBranchResult,
                  WorkConsoleError
                >((existing) => {
                  if (existing.exitCode === 0) {
                    return run(runner, repoRoot, ['switch', branch]).map(
                      (): EnsureBranchResult => ({
                        action: 'switched',
                        branch,
                        repoRoot,
                      }),
                    );
                  }
                  return run(runner, repoRoot, ['switch', '-c', branch]).map(
                    (): EnsureBranchResult => ({
                      action: 'created_and_switched',
                      branch,
                      repoRoot,
                    }),
                  );
                }),
              );
            },
          );
        },
      );
    },
  );
}

/** Probe the current branch without trying to switch. Used by `get_work_console_state`. */
export function readCurrentBranch(args: {
  config: WorkConsoleConfig;
  runner?: GitRunner;
}): ResultAsync<{ branch: string | null; repoRoot: string | null }, WorkConsoleError> {
  const runner = args.runner ?? defaultGitRunner;
  const { cwd } = args.config;
  return tryRun(runner, cwd, ['rev-parse', '--show-toplevel']).andThen<
    { branch: string | null; repoRoot: string | null },
    WorkConsoleError
  >((toplevel) => {
    if (toplevel.exitCode !== 0) {
      return okAsync({
        branch: null,
        repoRoot: null,
      });
    }
    const repoRoot = toplevel.stdout.trim();
    return tryRun(runner, repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD']).map(
      (head): { branch: string | null; repoRoot: string | null } => ({
        branch: head.exitCode === 0 ? head.stdout.trim() : null,
        repoRoot,
      }),
    );
  });
}
