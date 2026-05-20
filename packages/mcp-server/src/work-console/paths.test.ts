/**
 * Tests for `resolveSafe`. The job is to reject path-traversal attempts
 * even when they're obfuscated through `../` chains, while accepting
 * normal relative paths under the console dir.
 */

import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveWorkConsoleConfig } from './config.ts';
import { consoleDir, feedbackLogPath, resolveSafe } from './paths.ts';

const config = resolveWorkConsoleConfig({
  cwd: '/tmp/slop-console-test',
  branch: 'ai-work-console',
  consoleRelDir: '.console',
});

describe('consoleDir', () => {
  it('joins cwd with consoleRelDir', () => {
    expect(consoleDir(config)).toBe('/tmp/slop-console-test/.console');
  });
});

describe('feedbackLogPath', () => {
  it('joins cwd with feedbackRelPath', () => {
    const c = resolveWorkConsoleConfig({
      cwd: '/tmp/x',
      feedbackRelPath: '.state/feedback.jsonl',
    });
    expect(feedbackLogPath(c)).toBe('/tmp/x/.state/feedback.jsonl');
  });
});

describe('resolveSafe', () => {
  it('accepts a normal relative path', () => {
    const r = resolveSafe(config, 'work/observability.md');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe(resolve(consoleDir(config), 'work/observability.md'));
  });

  it('rejects a path with ../ that escapes the console dir', () => {
    const r = resolveSafe(config, '../../etc/passwd');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('WORK_CONSOLE_PATH_OUTSIDE');
  });

  it('rejects a path with an absolute prefix that resolves outside the console dir', () => {
    const r = resolveSafe(config, '/etc/passwd');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('WORK_CONSOLE_PATH_OUTSIDE');
  });

  it('accepts a deeply nested path inside the console dir', () => {
    const r = resolveSafe(config, 'a/b/c/d/file.md');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.endsWith('a/b/c/d/file.md')).toBe(true);
  });

  it('accepts an absolute path that happens to be inside the console dir', () => {
    const inside = `${consoleDir(config)}/work/foo.md`;
    const r = resolveSafe(config, inside);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toBe(inside);
  });
});
