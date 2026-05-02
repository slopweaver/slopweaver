import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Walks up from this module's directory until a `pnpm-workspace.yaml` is
 * found, treating that directory as the monorepo root. Throws if the file
 * isn't found before reaching `/` (which would indicate a broken install).
 */
export function findMonorepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  let current = resolve(here);
  while (current !== '/') {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }
    current = dirname(current);
  }
  throw new Error('could not find monorepo root (no pnpm-workspace.yaml above this file)');
}

/**
 * Worktrees live as a sibling of the monorepo, one directory up.
 *
 * For `~/dev/slopweaver`, worktrees go in `~/dev/worktrees/`.
 */
export function resolveWorktreesRoot({ repoRoot }: { repoRoot: string }): string {
  return join(dirname(repoRoot), 'worktrees');
}
