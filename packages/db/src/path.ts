/**
 * SlopWeaver data-directory and database path resolvers.
 *
 * Honours the XDG Base Directory specification: when `XDG_DATA_HOME` is set
 * and non-empty, data lives under `$XDG_DATA_HOME/slopweaver`; otherwise it
 * lives under `~/.slopweaver`. The default DB filename is `slopweaver.db`.
 *
 * Both helpers accept an options object so tests can inject `home` and
 * `xdgDataHome` without touching `process.env`.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { err, ok, type Result } from '@slopweaver/errors';
import { type DataPathInvalidError, DbErrors } from './errors.ts';

/**
 * Common option bag accepted by both resolvers. All fields are optional —
 * unset values fall through to the corresponding `process.env` / `os.homedir`
 * default.
 */
type ResolvePathOptions = {
  /** Override for `os.homedir()`. */
  home?: string;
  /** Override for `process.env.XDG_DATA_HOME`. Pass `''` to force the home fallback. */
  xdgDataHome?: string;
};

/**
 * Resolve the SlopWeaver data directory.
 *
 * If `XDG_DATA_HOME` (or the injected `xdgDataHome`) is non-empty, returns
 * `<xdgDataHome>/slopweaver`. Otherwise returns `<home>/.slopweaver`.
 *
 * Per the XDG Base Directory specification, `XDG_DATA_HOME` must be an
 * absolute path; relative values are rejected so misconfigured environments
 * fail fast at startup instead of silently writing SQLite under the caller's
 * cwd.
 */
export function resolveDataDir({ home, xdgDataHome }: ResolvePathOptions = {}): Result<string, DataPathInvalidError> {
  const resolvedXdgDataHome = xdgDataHome ?? process.env['XDG_DATA_HOME'];

  if (resolvedXdgDataHome) {
    if (!isAbsolute(resolvedXdgDataHome)) {
      return err(DbErrors.dataPathInvalid(resolvedXdgDataHome));
    }
    return ok(join(resolvedXdgDataHome, 'slopweaver'));
  }

  return ok(join(home ?? homedir(), '.slopweaver'));
}

/**
 * Resolve the absolute path to the SlopWeaver SQLite database file.
 * Equivalent to {@link resolveDataDir} joined with `slopweaver.db`.
 */
export function resolveDbPath(options: ResolvePathOptions = {}): Result<string, DataPathInvalidError> {
  return resolveDataDir(options).map((dir) => join(dir, 'slopweaver.db'));
}

/**
 * Resolve the absolute path to the SlopWeaver **demo** SQLite database file.
 *
 * The demo DB is a sibling of the real `slopweaver.db` under the same
 * XDG-resolved data directory, named `demo.db`. Keeping it side-by-side
 * (rather than in a separate tmp dir) means the same `slopweaver doctor` /
 * Diagnostics UI surfaces work against demo state, and the user can flip
 * between demo and real without re-copying anything. The two files never
 * mix because the resolver here is the single source of truth and is only
 * consulted when the caller asks for demo mode.
 */
export function resolveDemoDbPath(options: ResolvePathOptions = {}): Result<string, DataPathInvalidError> {
  return resolveDataDir(options).map((dir) => join(dir, 'demo.db'));
}
