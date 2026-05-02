/**
 * `pnpm cli worktree new <name>`
 *
 * Creates a fresh git worktree from the latest `origin/main`, one directory
 * above the monorepo root, on a new branch `worktree/<name>`. Optionally
 * runs `pnpm install` in the new worktree (default: yes).
 *
 * Adapted from slopweaver-private/packages/cli-tools/src/worktree/index.ts.
 * Simpler here — no .env sync, no platform-specific patches; just create
 * the worktree and install deps.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { findMonorepoRoot, resolveWorktreesRoot } from '../lib/paths.ts';

/** Sanitises a free-text task name into a slug-safe branch + path component. */
export function sanitiseTaskName({ input }: { input: string }): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export type WorktreeNewOptions = { install: boolean };

export function runWorktreeNew({
  rawName,
  options,
}: {
  rawName: string;
  options: WorktreeNewOptions;
}): void {
  const safeName = sanitiseTaskName({ input: rawName });
  if (!safeName) {
    console.error('error: task name produced an empty slug after sanitisation');
    process.exit(1);
  }

  const repoRoot = findMonorepoRoot();
  const worktreesRoot = resolveWorktreesRoot({ repoRoot });
  const worktreePath = join(worktreesRoot, safeName);
  const branchName = `worktree/${safeName}`;
  const baseRef = 'origin/main';

  console.log(`creating worktree: ${worktreePath}`);
  console.log(`new branch:        ${branchName}`);
  console.log(`from:              ${baseRef}`);
  console.log('');

  const fetchResult = spawnSync('git', ['fetch', 'origin', 'main'], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (fetchResult.status !== 0) {
    process.exit(fetchResult.status ?? 1);
  }

  const addResult = spawnSync('git', ['worktree', 'add', '-b', branchName, worktreePath, baseRef], {
    cwd: repoRoot,
    stdio: 'inherit',
  });
  if (addResult.status !== 0) {
    process.exit(addResult.status ?? 1);
  }

  if (options.install) {
    console.log('');
    console.log(`installing deps in ${worktreePath}`);
    const installResult = spawnSync('pnpm', ['install'], {
      cwd: worktreePath,
      stdio: 'inherit',
    });
    if (installResult.status !== 0) {
      process.exit(installResult.status ?? 1);
    }
  }

  console.log('');
  console.log('✓ worktree ready');
  console.log(`next: cd ${worktreePath}`);
}
