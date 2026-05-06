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
 *
 * @param options - Optional overrides for testing.
 * @returns Absolute filesystem path to the SlopWeaver data directory.
 * @throws {Error} If the resolved `XDG_DATA_HOME` is not an absolute path.
 *
 * @example
 * resolveDataDir({ xdgDataHome: '/var/lib' }); // '/var/lib/slopweaver'
 * resolveDataDir({ home: '/Users/alice', xdgDataHome: '' }); // '/Users/alice/.slopweaver'
 */
export function resolveDataDir({ home, xdgDataHome }: ResolvePathOptions = {}): string {
  const resolvedXdgDataHome = xdgDataHome ?? process.env.XDG_DATA_HOME;

  if (resolvedXdgDataHome) {
    if (!isAbsolute(resolvedXdgDataHome)) {
      throw new Error(`XDG_DATA_HOME must be an absolute path; got: "${resolvedXdgDataHome}"`);
    }
    return join(resolvedXdgDataHome, 'slopweaver');
  }

  return join(home ?? homedir(), '.slopweaver');
}

/**
 * Resolve the absolute path to the SlopWeaver SQLite database file.
 * Equivalent to {@link resolveDataDir} joined with `slopweaver.db`.
 *
 * @param options - Optional overrides for testing.
 * @returns Absolute filesystem path to `slopweaver.db`.
 *
 * @example
 * resolveDbPath({ xdgDataHome: '/var/lib' }); // '/var/lib/slopweaver/slopweaver.db'
 */
export function resolveDbPath(options: ResolvePathOptions = {}): string {
  return join(resolveDataDir(options), 'slopweaver.db');
}
