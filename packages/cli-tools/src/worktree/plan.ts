import { join } from 'node:path';

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

export type BuildPlanResult = { ok: true; plan: WorktreePlan } | { ok: false; error: string };

export function buildWorktreePlan({
  rawName,
  worktreesRoot,
}: {
  rawName: string;
  worktreesRoot: string;
}): BuildPlanResult {
  const safeName = sanitiseTaskName({ input: rawName });
  if (!safeName) {
    return {
      ok: false,
      error: 'task name produced an empty slug after sanitisation',
    };
  }
  return {
    ok: true,
    plan: {
      safeName,
      worktreePath: join(worktreesRoot, safeName),
      branchName: `worktree/${safeName}`,
      baseRef: 'origin/main',
    },
  };
}
