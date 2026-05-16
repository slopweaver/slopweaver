import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir } from './data-dir.ts';

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

  it('defaults to os.homedir() when no home is supplied and XDG_DATA_HOME is unset', () => {
    const result = resolveDataDir({ xdgDataHome: '' });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toBe(join(homedir(), '.slopweaver'));
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
