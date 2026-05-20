/**
 * Tests for the work-console file helpers. Uses a real temp directory
 * — these are intentionally NOT pure: they exercise the atomic-write
 * + jail-enforcement contract end to end.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from './config.ts';
import { listConsoleDir, safeAppendJsonl, safeReadConsoleFile, safeStat, safeWriteConsoleFile } from './files.ts';

let tempCwd: string;
let config: WorkConsoleConfig;

beforeEach(() => {
  tempCwd = mkdtempSync(join(tmpdir(), 'slop-files-'));
  config = resolveWorkConsoleConfig({ cwd: tempCwd, branch: 'ai-work-console' });
});

afterEach(() => {
  rmSync(tempCwd, { recursive: true, force: true });
});

describe('safeWriteConsoleFile + safeReadConsoleFile round-trip', () => {
  it('writes a file, reads it back, reports created=true on first write', async () => {
    const write = await safeWriteConsoleFile(config, 'work/hello.md', '# hello world\n');
    expect(write.isOk()).toBe(true);
    if (write.isOk()) {
      expect(write.value.created).toBe(true);
      expect(write.value.bytesWritten).toBe(Buffer.byteLength('# hello world\n', 'utf-8'));
    }
    const read = await safeReadConsoleFile(config, 'work/hello.md');
    expect(read.isOk()).toBe(true);
    if (read.isOk()) {
      expect(read.value.exists).toBe(true);
      expect(read.value.content).toBe('# hello world\n');
    }
  });

  it('returns exists=false for a missing file (not an error)', async () => {
    const read = await safeReadConsoleFile(config, 'work/never.md');
    expect(read.isOk()).toBe(true);
    if (read.isOk()) {
      expect(read.value.exists).toBe(false);
      expect(read.value.content).toBe(null);
    }
  });

  it('reports created=false on a second overwrite', async () => {
    await safeWriteConsoleFile(config, 'work/hello.md', 'first');
    const second = await safeWriteConsoleFile(config, 'work/hello.md', 'second');
    expect(second.isOk()).toBe(true);
    if (second.isOk()) expect(second.value.created).toBe(false);
  });

  it('refuses to create a new file when createIfMissing is false', async () => {
    const r = await safeWriteConsoleFile(config, 'work/new.md', 'x', { createIfMissing: false });
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('WORK_CONSOLE_FILE_MISSING');
  });

  it('rejects writes that resolve outside the console dir', async () => {
    const r = await safeWriteConsoleFile(config, '../escape.md', 'oops');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('WORK_CONSOLE_PATH_OUTSIDE');
  });
});

describe('listConsoleDir', () => {
  it('returns an empty list for a missing console dir', async () => {
    const r = await listConsoleDir(config, '.');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.subdir).toBe('.');
      expect(r.value.entries).toEqual([]);
    }
  });

  it('lists files alphabetically with their stat metadata', async () => {
    await safeWriteConsoleFile(config, 'work/b.md', 'b');
    await safeWriteConsoleFile(config, 'work/a.md', 'a');
    const r = await listConsoleDir(config, 'work');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.entries.map((e) => e.relPath)).toEqual(['work/a.md', 'work/b.md']);
      const first = r.value.entries[0];
      expect(first?.kind).toBe('file');
      expect(first?.bytes).toBe(1);
      expect(first?.modifiedAtIso).not.toBe(null);
    }
  });
});

describe('safeAppendJsonl', () => {
  it('creates the file with a trailing newline on first append', async () => {
    const absPath = resolve(tempCwd, '.console/state/log.jsonl');
    const r = await safeAppendJsonl(absPath, '{"a":1}');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.bytesAppended).toBeGreaterThan(0);
    const read = await safeReadConsoleFile(
      resolveWorkConsoleConfig({ cwd: tempCwd, consoleRelDir: '.console' }),
      'state/log.jsonl',
    );
    expect(read.isOk()).toBe(true);
    if (read.isOk()) expect(read.value.content).toBe('{"a":1}\n');
  });

  it('appends a second line without overwriting the first', async () => {
    const absPath = resolve(tempCwd, '.console/state/log.jsonl');
    await safeAppendJsonl(absPath, '{"a":1}');
    await safeAppendJsonl(absPath, '{"b":2}');
    const read = await safeReadConsoleFile(
      resolveWorkConsoleConfig({ cwd: tempCwd, consoleRelDir: '.console' }),
      'state/log.jsonl',
    );
    expect(read.isOk()).toBe(true);
    if (read.isOk()) expect(read.value.content).toBe('{"a":1}\n{"b":2}\n');
  });
});

describe('safeStat', () => {
  it('returns exists=false for a missing path', async () => {
    const r = await safeStat(resolve(tempCwd, 'nothing'));
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.exists).toBe(false);
      expect(r.value.isDir).toBe(false);
    }
  });

  it('returns isDir=true for a directory', async () => {
    const r = await safeStat(tempCwd);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.exists).toBe(true);
      expect(r.value.isDir).toBe(true);
    }
  });

  it('returns isDir=false for a regular file', async () => {
    const p = resolve(tempCwd, 'file.txt');
    writeFileSync(p, 'x');
    const r = await safeStat(p);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.exists).toBe(true);
      expect(r.value.isDir).toBe(false);
    }
  });
});
