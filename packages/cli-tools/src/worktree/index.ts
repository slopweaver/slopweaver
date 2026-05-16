/**
 * `pnpm cli worktree-new <name>`
 *
 * Creates a fresh git worktree from the latest `origin/main`, one directory
 * above the monorepo root, on a new branch `worktree/<name>`. Optionally
 * runs `pnpm install` in the new worktree (default: yes).
 *
 * Pure plan-building lives in `./plan.ts`. This file orchestrates: it
 * resolves the monorepo root, builds the plan, then runs git + pnpm via
 * the injected `exec` so tests can stub the subprocess layer.
 *
 * Returns `Result<{ worktreePath }, WorktreeError>`. Each `WorktreeError`
 * variant carries an `exitCode` so the CLI boundary can pass it straight
 * to `process.exit(...)` without re-deriving from the discriminant.
 */

import { err, ok, type Result } from '@slopweaver/errors';
import { spawnSync } from 'node:child_process';
import { findMonorepoRoot, resolveWorktreesRoot } from '../lib/paths.ts';
import { type WorktreeError, WorktreeErrors } from './errors.ts';
import { buildWorktreePlan } from './plan.ts';

export type WorktreeNewOptions = { install: boolean };

export type ExecResult = { status: number };

export type ExecFn = (cmd: string, args: string[], opts: { cwd: string }) => ExecResult;

export type RunWorktreeNewSuccess = { worktreePath: string };

export type RunWorktreeNewDeps = {
  exec?: ExecFn;
  log?: (line: string) => void;
  resolveRoots?: () => { repoRoot: string; worktreesRoot: string };
};

const defaultExec: ExecFn = (cmd, args, opts) => {
  const result = spawnSync(cmd, args, { cwd: opts.cwd, stdio: 'inherit' });
  return { status: result.status ?? 1 };
};

const defaultResolveRoots = (): { repoRoot: string; worktreesRoot: string } => {
  const repoRoot = findMonorepoRoot();
  return { repoRoot, worktreesRoot: resolveWorktreesRoot({ repoRoot }) };
};

export function runWorktreeNew({
  rawName,
  options,
  deps = {},
}: {
  rawName: string;
  options: WorktreeNewOptions;
  deps?: RunWorktreeNewDeps;
}): Result<RunWorktreeNewSuccess, WorktreeError> {
  const exec = deps.exec ?? defaultExec;
  const log = deps.log ?? console.log;
  const resolveRoots = deps.resolveRoots ?? defaultResolveRoots;

  const { repoRoot, worktreesRoot } = resolveRoots();
  const planResult = buildWorktreePlan({ rawName, worktreesRoot });
  if (planResult.isErr()) return err(planResult.error);
  const plan = planResult.value;

  log(`creating worktree: ${plan.worktreePath}`);
  log(`new branch:        ${plan.branchName}`);
  log(`from:              ${plan.baseRef}`);
  log('');

  const fetchResult = exec('git', ['fetch', 'origin', 'main'], { cwd: repoRoot });
  if (fetchResult.status !== 0) {
    return err(WorktreeErrors.gitFetchFailed(fetchResult.status));
  }

  const addResult = exec(
    'git',
    ['worktree', 'add', '-b', plan.branchName, plan.worktreePath, plan.baseRef],
    { cwd: repoRoot },
  );
  if (addResult.status !== 0) {
    return err(WorktreeErrors.gitAddFailed(addResult.status));
  }

  if (options.install) {
    log('');
    log(`installing deps in ${plan.worktreePath}`);
    const installResult = exec('pnpm', ['install'], { cwd: plan.worktreePath });
    if (installResult.status !== 0) {
      return err(WorktreeErrors.pnpmInstallFailed(installResult.status));
    }
  }

  log('');
  log('✓ worktree ready');
  log(`next: cd ${plan.worktreePath}`);
  return ok({ worktreePath: plan.worktreePath });
}
