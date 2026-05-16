import { err, ok, type Result } from '@slopweaver/errors';
import { join } from 'node:path';
import { type WorktreeError, WorktreeErrors } from './errors.ts';

/** Sanitises a free-text task name into a slug-safe branch + path component. */
export function sanitiseTaskName({ input }: { input: string }): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/--+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export type WorktreePlan = {
  safeName: string;
  worktreePath: string;
  branchName: string;
  baseRef: string;
};

export function buildWorktreePlan({
  rawName,
  worktreesRoot,
}: {
  rawName: string;
  worktreesRoot: string;
}): Result<WorktreePlan, WorktreeError> {
  const safeName = sanitiseTaskName({ input: rawName });
  if (!safeName) {
    return err(WorktreeErrors.invalidName('task name produced an empty slug after sanitisation'));
  }
  return ok({
    safeName,
    worktreePath: join(worktreesRoot, safeName),
    branchName: `worktree/${safeName}`,
    baseRef: 'origin/main',
  });
}
