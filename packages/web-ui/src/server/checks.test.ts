import { mkdtempSync, rmSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkDataDir, checkNodeVersion, checkPnpmVersion, runStaticEnvChecks } from './checks.ts';

describe('checkNodeVersion', () => {
  it('passes for the required major', () => {
    const result = checkNodeVersion({ nodeVersion: '22.10.0' });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('22.10.0');
  });

  it('passes for a higher major', () => {
    expect(checkNodeVersion({ nodeVersion: '24.0.0' }).status).toBe('ok');
  });

  it('fails for a lower major', () => {
    const result = checkNodeVersion({ nodeVersion: '20.11.0' });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('need >=22');
  });
});

describe('checkPnpmVersion', () => {
  it('passes for the required major', () => {
    const result = checkPnpmVersion({ getVersion: () => ({ ok: true, version: '10.6.1' }) });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('10.6.1');
  });

  it('warns for a lower major', () => {
    const result = checkPnpmVersion({ getVersion: () => ({ ok: true, version: '9.15.0' }) });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('9.15.0');
  });

  it('warns when pnpm is not installed', () => {
    const result = checkPnpmVersion({ getVersion: () => ({ ok: false, reason: 'not-found' }) });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('not on PATH');
  });

  it('warns on timeout', () => {
    const result = checkPnpmVersion({ getVersion: () => ({ ok: false, reason: 'timeout' }) });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('timed out');
  });

  it('warns on generic error', () => {
    const result = checkPnpmVersion({
      getVersion: () => ({ ok: false, reason: 'error', detail: 'exit 7' }),
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('exit 7');
  });
});

describe('checkDataDir', () => {
  it('passes when the directory exists and is writable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-ui-checks-'));
    try {
      const result = checkDataDir({ dataDir: dir });
      expect(result.status).toBe('ok');
      expect(result.detail).toContain('writable');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('warns when the directory is missing', () => {
    const result = checkDataDir({
      dataDir: join(tmpdir(), 'web-ui-checks-missing-xyz123'),
    });
    expect(result.status).toBe('warn');
    expect(result.detail).toContain('missing');
  });

  it('fails when the path is a file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-ui-checks-'));
    const file = join(dir, 'not-a-dir');
    writeFileSync(file, 'hi');
    try {
      const result = checkDataDir({ dataDir: file });
      expect(result.status).toBe('fail');
      expect(result.detail).toContain('not a directory');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails when the directory is not writable', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return; // chmod semantics differ.
    const dir = mkdtempSync(join(tmpdir(), 'web-ui-checks-'));
    try {
      chmodSync(dir, 0o500);
      const result = checkDataDir({ dataDir: dir });
      expect(result.status).toBe('fail');
      expect(result.detail).toMatch(/not writable/);
    } finally {
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runStaticEnvChecks', () => {
  it('returns all three categories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'web-ui-checks-'));
    try {
      const result = runStaticEnvChecks({ dataDir: dir });
      expect(result.node.name).toBe('Node version');
      expect(result.pnpm.name).toBe('pnpm version');
      expect(result.dataDir.name).toBe('Data dir');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
