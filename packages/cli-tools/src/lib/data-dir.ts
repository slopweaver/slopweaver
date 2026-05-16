/**
 * Resolver for the SlopWeaver dev-tooling data directory.
 *
 * Mirrors the XDG-aware logic in `@slopweaver/db`'s `path.ts`: when
 * `XDG_DATA_HOME` is set, data lives under `$XDG_DATA_HOME/slopweaver`;
 * otherwise under `~/.slopweaver`. Kept as a per-package helper (rather
 * than imported from `@slopweaver/db`) so cli-tools has no runtime
 * dependency on the SQLite stack.
 *
 * Returns the same `DataPathInvalidError` shape (`code: 'DATA_PATH_INVALID'`)
 * that `@slopweaver/db` returns, so a caller that mixes both resolvers can
 * exhaustively match on one union.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '@slopweaver/errors';
import { type DataPathInvalidError, LibErrors } from './errors.ts';

/**
 * Resolve the directory SlopWeaver uses for local data (database, cached
 * tokens, logs).
 *
 * Per the XDG Base Directory specification, `XDG_DATA_HOME` must be an
 * absolute path; relative values are rejected so misconfigured environments
 * fail fast instead of writing data under the caller's cwd.
 */
export function resolveDataDir({
  home,
  xdgDataHome,
}: {
  home?: string;
  xdgDataHome?: string;
} = {}): Result<string, DataPathInvalidError> {
  const resolvedXdgDataHome = xdgDataHome ?? process.env.XDG_DATA_HOME;

  if (resolvedXdgDataHome) {
    if (!isAbsolute(resolvedXdgDataHome)) {
      return err(LibErrors.dataPathInvalid(resolvedXdgDataHome));
    }
    return ok(join(resolvedXdgDataHome, 'slopweaver'));
  }

  return ok(join(home ?? homedir(), '.slopweaver'));
}
