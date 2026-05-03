/**
 * Unit tests for the XDG-aware path resolvers in `path.ts`.
 *
 * Both helpers are pure (with `home` / `xdgDataHome` injected), so these
 * tests never read the real `process.env` or `os.homedir()` — except the
 * single fallback case that proves the default flows through correctly.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir, resolveDbPath } from './path.ts';

describe('resolveDataDir', () => {
  it('uses XDG_DATA_HOME when supplied', () => {
    expect(resolveDataDir({ home: '/tmp/fakehome', xdgDataHome: '/tmp/xdg' })).toBe(
      '/tmp/xdg/slopweaver',
    );
  });

  it('falls back to .slopweaver under the supplied home directory when XDG_DATA_HOME is unset', () => {
    expect(resolveDataDir({ home: '/tmp/fakehome', xdgDataHome: '' })).toBe(
      '/tmp/fakehome/.slopweaver',
    );
  });
});

describe('resolveDbPath', () => {
  it('appends slopweaver.db to the XDG-aware data dir', () => {
    expect(resolveDbPath({ xdgDataHome: '/tmp/xdg' })).toBe('/tmp/xdg/slopweaver/slopweaver.db');
  });

  it('defaults to os.homedir() when no home is supplied and XDG_DATA_HOME is unset', () => {
    expect(resolveDbPath({ xdgDataHome: '' })).toBe(
      join(homedir(), '.slopweaver', 'slopweaver.db'),
    );
  });
});
