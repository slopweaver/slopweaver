/**
 * Tests for `resolveWorkConsoleConfig`. Pure resolver; assertions are
 * about precedence order between args / env / defaults.
 */

import { isAbsolute } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONSOLE_REL_DIR,
  DEFAULT_FEEDBACK_REL_PATH,
  DEFAULT_WORK_CONSOLE_BRANCH,
  resolveWorkConsoleConfig,
} from './config.ts';

describe('resolveWorkConsoleConfig', () => {
  it('returns sensible defaults when nothing is supplied', () => {
    const config = resolveWorkConsoleConfig({ cwd: '/tmp/some/repo' });
    expect(config.branch).toBe(DEFAULT_WORK_CONSOLE_BRANCH);
    expect(config.consoleRelDir).toBe(DEFAULT_CONSOLE_REL_DIR);
    expect(config.feedbackRelPath).toBe(DEFAULT_FEEDBACK_REL_PATH);
    expect(config.cwd).toBe('/tmp/some/repo');
  });

  it('honours args over env over defaults', () => {
    const config = resolveWorkConsoleConfig({
      cwd: '/x',
      branch: 'arg-branch',
      env: {
        SLOPWEAVER_CONSOLE_BRANCH: 'env-branch',
        SLOPWEAVER_CONSOLE_DIR: '.env-console',
      },
    });
    expect(config.branch).toBe('arg-branch');
    expect(config.consoleRelDir).toBe('.env-console');
  });

  it('falls back to env when no arg is supplied', () => {
    const config = resolveWorkConsoleConfig({
      cwd: '/x',
      env: { SLOPWEAVER_FEEDBACK_LOG: '.custom/feedback.jsonl' },
    });
    expect(config.feedbackRelPath).toBe('.custom/feedback.jsonl');
    expect(config.branch).toBe(DEFAULT_WORK_CONSOLE_BRANCH);
  });

  it('resolves a relative cwd to absolute', () => {
    const config = resolveWorkConsoleConfig({ cwd: 'relative/path' });
    expect(isAbsolute(config.cwd)).toBe(true);
    expect(config.cwd.endsWith('relative/path')).toBe(true);
  });

  it('freezes the returned object', () => {
    const config = resolveWorkConsoleConfig({ cwd: '/x' });
    expect(Object.isFrozen(config)).toBe(true);
  });

  it('treats an empty env value as unset', () => {
    const config = resolveWorkConsoleConfig({
      cwd: '/x',
      env: { SLOPWEAVER_CONSOLE_BRANCH: '   ' },
    });
    expect(config.branch).toBe(DEFAULT_WORK_CONSOLE_BRANCH);
  });
});
