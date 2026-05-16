import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { err, ok, type Result } from '@slopweaver/errors';
import { type MonorepoRootNotFoundError, LibErrors } from './errors.ts';

/**
 * Walks up from this module's directory until a `pnpm-workspace.yaml` is
 * found, treating that directory as the monorepo root. Returns
 * `Result<string, MonorepoRootNotFoundError>` so callers at the CLI
 * boundary can surface a clean error message instead of an unhandled
 * exception — the file not being found above the bin's install path
 * implies a broken install, not a recoverable runtime condition.
 */
export function findMonorepoRoot(): Result<string, MonorepoRootNotFoundError> {
  const here = dirname(fileURLToPath(import.meta.url));
  let current = resolve(here);
  while (current !== '/') {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return ok(current);
    }
    current = dirname(current);
  }
  return err(LibErrors.monorepoRootNotFound(here));
}

/**
 * Worktrees live as a sibling of the monorepo, one directory up.
 *
 * For `~/dev/slopweaver`, worktrees go in `~/dev/worktrees/`.
 */
export function resolveWorktreesRoot({ repoRoot }: { repoRoot: string }): string {
  return join(dirname(repoRoot), 'worktrees');
}
