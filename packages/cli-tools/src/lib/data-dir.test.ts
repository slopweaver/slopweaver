import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveDataDir } from './data-dir.ts';

describe('resolveDataDir', () => {
  it('joins .slopweaver onto the supplied home directory', () => {
    expect(resolveDataDir({ home: '/tmp/fakehome' })).toBe('/tmp/fakehome/.slopweaver');
  });

  it('defaults to os.homedir() when no home is supplied', () => {
    expect(resolveDataDir()).toBe(join(homedir(), '.slopweaver'));
  });
});
