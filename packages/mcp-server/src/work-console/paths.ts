/**
 * Path resolution + jail enforcement for work-console file IO.
 *
 * Every tool that writes into the user's repo goes through `resolveSafe`.
 * It rejects paths that escape the console dir (`../`, absolute paths,
 * symlink targets outside the dir). The point is to give the user
 * confidence that "`/write-console-file path=foo content=bar`" cannot
 * clobber arbitrary files on their machine even if a prompt is poisoned
 * by upstream input.
 */

import { resolve, relative, isAbsolute, sep } from 'node:path';
import { type Result, err, ok } from '@slopweaver/errors';
import { type WorkConsoleConfig } from './config.ts';
import { type WorkConsoleError, WorkConsoleErrors } from './errors.ts';

/** Absolute path to the console directory. */
export function consoleDir(config: WorkConsoleConfig): string {
  return resolve(config.cwd, config.consoleRelDir);
}

/** Absolute path to the feedback log. */
export function feedbackLogPath(config: WorkConsoleConfig): string {
  return resolve(config.cwd, config.feedbackRelPath);
}

/**
 * Resolve a relative-or-absolute path against the console dir, ensuring the
 * result stays inside the console jail. Returns the absolute, normalized
 * path on success. Returns a typed `WorkConsoleError` on escape attempts.
 *
 * Note: this does not stat the path. Symlink-target escapes are caught at
 * write time by the IO helpers themselves; the jail check here is the
 * syntactic guard.
 */
export function resolveSafe(config: WorkConsoleConfig, inputPath: string): Result<string, WorkConsoleError> {
  const base = consoleDir(config);
  const candidate = isAbsolute(inputPath) ? inputPath : resolve(base, inputPath);
  const rel = relative(base, candidate);
  if (rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    return err(WorkConsoleErrors.pathOutside(inputPath, base));
  }
  return ok(candidate);
}
