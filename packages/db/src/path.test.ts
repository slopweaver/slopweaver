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
import { resolveDataDir, resolveDbPath, resolveDemoDbPath } from './path.ts';

describe('resolveDataDir', () => {
  it('uses XDG_DATA_HOME when supplied', () => {
    const result = resolveDataDir({ home: '/tmp/fakehome', xdgDataHome: '/tmp/xdg' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('/tmp/xdg/slopweaver');
    }
  });

  it('falls back to .slopweaver under the supplied home directory when XDG_DATA_HOME is unset', () => {
    const result = resolveDataDir({ home: '/tmp/fakehome', xdgDataHome: '' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('/tmp/fakehome/.slopweaver');
    }
  });

  it('returns DATA_PATH_INVALID when XDG_DATA_HOME is set to a relative path', () => {
    const result = resolveDataDir({ xdgDataHome: 'tmp/relative' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('DATA_PATH_INVALID');
      expect(result.error.xdgDataHome).toBe('tmp/relative');
      expect(result.error.message).toMatch(/XDG_DATA_HOME must be an absolute path/);
    }
  });
});

describe('resolveDbPath', () => {
  it('appends slopweaver.db to the XDG-aware data dir', () => {
    const result = resolveDbPath({ xdgDataHome: '/tmp/xdg' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('/tmp/xdg/slopweaver/slopweaver.db');
    }
  });

  it('defaults to os.homedir() when no home is supplied and XDG_DATA_HOME is unset', () => {
    const result = resolveDbPath({ xdgDataHome: '' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(join(homedir(), '.slopweaver', 'slopweaver.db'));
    }
  });

  it('propagates DATA_PATH_INVALID from resolveDataDir', () => {
    const result = resolveDbPath({ xdgDataHome: 'tmp/relative' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('DATA_PATH_INVALID');
    }
  });
});

describe('resolveDemoDbPath', () => {
  it('appends demo.db (not slopweaver.db) to the XDG-aware data dir', () => {
    const result = resolveDemoDbPath({ xdgDataHome: '/tmp/xdg' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe('/tmp/xdg/slopweaver/demo.db');
    }
  });

  it('sits beside slopweaver.db under the same data dir (sibling, not nested)', () => {
    const real = resolveDbPath({ xdgDataHome: '/tmp/xdg' });
    const demo = resolveDemoDbPath({ xdgDataHome: '/tmp/xdg' });
    expect(real.isOk()).toBe(true);
    expect(demo.isOk()).toBe(true);
    if (real.isOk() && demo.isOk()) {
      // Same parent directory; different filename. This is what makes
      // `slopweaver doctor` / Diagnostics UI work transparently against
      // either file without a directory remount.
      expect(real.value.replace(/[^/]+$/, '')).toBe(demo.value.replace(/[^/]+$/, ''));
      expect(real.value).not.toBe(demo.value);
    }
  });

  it('defaults to os.homedir() when no home is supplied and XDG_DATA_HOME is unset', () => {
    const result = resolveDemoDbPath({ xdgDataHome: '' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(join(homedir(), '.slopweaver', 'demo.db'));
    }
  });

  it('propagates DATA_PATH_INVALID from resolveDataDir', () => {
    const result = resolveDemoDbPath({ xdgDataHome: 'tmp/relative' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('DATA_PATH_INVALID');
    }
  });
});
