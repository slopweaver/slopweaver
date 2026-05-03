import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  checkDataDir,
  checkNodeVersion,
  checkPnpmVersion,
  checkPortFree,
  type GetVersionResult,
  LOCAL_API_PORT,
  PNPM_VERSION_TIMEOUT_MS,
  REQUIRED_NODE_MAJOR,
  REQUIRED_PNPM_MAJOR,
  type TryBindFn,
} from './checks.ts';

describe('checkNodeVersion', () => {
  it('returns ok when the major version meets the minimum', () => {
    const result = checkNodeVersion({ nodeVersion: `${REQUIRED_NODE_MAJOR}.0.0` });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain(`${REQUIRED_NODE_MAJOR}.0.0`);
  });

  it('returns ok when the major version exceeds the minimum', () => {
    const result = checkNodeVersion({ nodeVersion: `${REQUIRED_NODE_MAJOR + 2}.5.1` });
    expect(result.status).toBe('ok');
  });

  it('returns fail when the major version is below the minimum', () => {
    const result = checkNodeVersion({ nodeVersion: `${REQUIRED_NODE_MAJOR - 1}.99.99` });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('.nvmrc');
  });

  it('uses the live process version when none is supplied', () => {
    const result = checkNodeVersion();
    expect(result.detail).toContain(process.versions.node);
  });
});

describe('checkPnpmVersion', () => {
  function getVersion(result: GetVersionResult): () => GetVersionResult {
    return () => result;
  }

  it('returns fail with an install hint when pnpm is not on PATH', () => {
    const result = checkPnpmVersion({
      getVersion: getVersion({ ok: false, reason: 'not-found' }),
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('PATH');
  });

  it('returns fail with a timeout hint when the subprocess times out', () => {
    const result = checkPnpmVersion({
      getVersion: getVersion({ ok: false, reason: 'timeout' }),
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain(`${PNPM_VERSION_TIMEOUT_MS}ms`);
    expect(result.detail).toContain('corepack');
  });

  it('returns fail with the underlying error when pnpm exits non-zero', () => {
    const result = checkPnpmVersion({
      getVersion: getVersion({ ok: false, reason: 'error', detail: 'exit 1' }),
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('exit 1');
  });

  it('returns ok when the major meets the minimum', () => {
    const result = checkPnpmVersion({
      getVersion: getVersion({ ok: true, version: `${REQUIRED_PNPM_MAJOR}.0.0` }),
    });
    expect(result.status).toBe('ok');
  });

  it('returns fail with an upgrade hint when the major is too low', () => {
    const result = checkPnpmVersion({
      getVersion: getVersion({ ok: true, version: `${REQUIRED_PNPM_MAJOR - 1}.99.0` }),
    });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('corepack');
  });
});

describe('checkPortFree', () => {
  it('returns ok when tryBind succeeds', async () => {
    const tryBind: TryBindFn = async () => ({ ok: true });
    const result = await checkPortFree({ port: 12345, tryBind });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain('12345');
    expect(result.detail).toContain('available');
  });

  it('returns the in-use phrasing only for EADDRINUSE', async () => {
    const tryBind: TryBindFn = async () => ({ ok: false, code: 'EADDRINUSE' });
    const result = await checkPortFree({ port: 60701, tryBind });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('in use');
  });

  it('surfaces the actual error code for other bind failures', async () => {
    const tryBind: TryBindFn = async () => ({ ok: false, code: 'EACCES' });
    const result = await checkPortFree({ port: 80, tryBind });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('EACCES');
    expect(result.detail).not.toContain('in use');
  });

  it('exposes the local API port constant', () => {
    expect(LOCAL_API_PORT).toBe(60701);
  });
});

describe('checkDataDir', () => {
  let dir: string | null = null;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = null;
    }
  });

  it('returns ok when the data dir exists and is writable', () => {
    dir = mkdtempSync(join(tmpdir(), 'slopweaver-doctor-'));
    const result = checkDataDir({ dataDir: dir });
    expect(result.status).toBe('ok');
    expect(result.detail).toContain(dir);
    expect(result.detail).toContain('writable');
  });

  it('returns warn with fixable=create-data-dir when the path does not exist', () => {
    const missing = join(tmpdir(), `slopweaver-missing-${Date.now()}-${Math.random()}`);
    const result = checkDataDir({ dataDir: missing });
    expect(result.status).toBe('warn');
    expect(result.fixable).toBe('create-data-dir');
    expect(result.detail).toContain(missing);
  });

  it('returns fail when the path exists but is not a directory', () => {
    const parent = mkdtempSync(join(tmpdir(), 'slopweaver-doctor-'));
    dir = parent;
    const filePath = join(parent, 'not-a-dir');
    writeFileSync(filePath, 'this is a regular file, not a directory');
    const result = checkDataDir({ dataDir: filePath });
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('not a directory');
  });
});
