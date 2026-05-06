/**
 * Resolver for the SlopWeaver dev-tooling data directory.
 *
 * Mirrors the XDG-aware logic in `@slopweaver/db`'s `path.ts`: when
 * `XDG_DATA_HOME` is set, data lives under `$XDG_DATA_HOME/slopweaver`;
 * otherwise under `~/.slopweaver`. Kept as a per-package helper (rather
 * than imported from `@slopweaver/db`) so cli-tools has no runtime
 * dependency on the SQLite stack.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

/**
 * Resolve the directory SlopWeaver uses for local data (database, cached
 * tokens, logs).
 *
 * Per the XDG Base Directory specification, `XDG_DATA_HOME` must be an
 * absolute path; relative values are rejected so misconfigured environments
 * fail fast instead of writing data under the caller's cwd.
 *
 * @param options - Optional overrides. Inject `home` and/or `xdgDataHome`
 *   in tests to avoid touching the real environment.
 * @returns Absolute path to the SlopWeaver data directory.
 * @throws {Error} If the resolved `XDG_DATA_HOME` is not an absolute path.
 *
 * @example
 * resolveDataDir({ xdgDataHome: '/var/lib' }); // '/var/lib/slopweaver'
 * resolveDataDir({ home: '/Users/alice', xdgDataHome: '' }); // '/Users/alice/.slopweaver'
 */
export function resolveDataDir({
  home,
  xdgDataHome,
}: {
  home?: string;
  xdgDataHome?: string;
} = {}): string {
  const resolvedXdgDataHome = xdgDataHome ?? process.env.XDG_DATA_HOME;

  if (resolvedXdgDataHome) {
    if (!isAbsolute(resolvedXdgDataHome)) {
      throw new Error(`XDG_DATA_HOME must be an absolute path; got: "${resolvedXdgDataHome}"`);
    }
    return join(resolvedXdgDataHome, 'slopweaver');
  }

  return join(home ?? homedir(), '.slopweaver');
}
