import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir } from './data-dir.ts';

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

  it('defaults to os.homedir() when no home is supplied and XDG_DATA_HOME is unset', () => {
    expect(resolveDataDir({ xdgDataHome: '' })).toBe(join(homedir(), '.slopweaver'));
  });
});
