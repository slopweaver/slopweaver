import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runDoctor } from './index.ts';

describe('runDoctor (interactive contract)', () => {
  let originalHome: string | undefined;
  let tempHome: string | null = null;

  beforeEach(() => {
    originalHome = process.env.HOME;
    tempHome = mkdtempSync(join(tmpdir(), 'slopweaver-rundoctor-'));
    process.env.HOME = tempHome;
  });

  afterEach(() => {
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    }
    if (tempHome) {
      rmSync(tempHome, { recursive: true, force: true });
      tempHome = null;
    }
  });

  it('prompts to create the data dir when missing and creates it on yes', async () => {
    const prompt = vi.fn(async (_message: string) => true);
    const mkdir = vi.fn();
    const log = vi.fn();

    const result = await runDoctor({ prompt, mkdir, log });

    expect(prompt).toHaveBeenCalledOnce();
    expect(prompt.mock.calls[0]?.[0]).toContain('Create data dir at');
    expect(prompt.mock.calls[0]?.[0]).toContain('.slopweaver');

    expect(mkdir).toHaveBeenCalledOnce();
    expect(mkdir.mock.calls[0]?.[0]).toContain('.slopweaver');
    expect(result).toEqual({ ok: true });
  });

  it('does not prompt when the data dir already exists', async () => {
    if (!tempHome) throw new Error('tempHome should be set');
    // Pre-create the data dir so checkDataDir reports ok.
    const dataDir = join(tempHome, '.slopweaver');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(dataDir);

    const prompt = vi.fn(async () => true);
    const mkdir = vi.fn();
    const log = vi.fn();

    await runDoctor({ prompt, mkdir, log });

    expect(prompt).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();

    const summary = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).toContain('All good');
  });

  it('skips the mkdir when the user declines the prompt and reports a warning summary', async () => {
    const prompt = vi.fn(async () => false);
    const mkdir = vi.fn();
    const log = vi.fn();

    await runDoctor({ prompt, mkdir, log });

    expect(prompt).toHaveBeenCalledOnce();
    expect(mkdir).not.toHaveBeenCalled();

    if (!tempHome) throw new Error('tempHome should be set');
    expect(existsSync(join(tempHome, '.slopweaver'))).toBe(false);

    const summary = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).toMatch(/warning/i);
  });

  it('actually creates the directory when mkdir uses the real filesystem', async () => {
    const { mkdirSync } = await import('node:fs');
    const prompt = vi.fn(async () => true);
    const mkdir = vi.fn((path: string) => mkdirSync(path, { recursive: true }));
    const log = vi.fn();

    const result = await runDoctor({ prompt, mkdir, log });

    if (!tempHome) throw new Error('tempHome should be set');
    expect(existsSync(join(tempHome, '.slopweaver'))).toBe(true);
    expect(result).toEqual({ ok: true });

    const summary = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).toContain('All good');
  });

  it('returns ok=false with a non-zero exit code when any check fails', async () => {
    if (!tempHome) throw new Error('tempHome should be set');
    // Pre-create the data dir as a regular file so checkDataDir reports fail
    // (the new "exists but is not a directory" branch).
    const dataDirPath = join(tempHome, '.slopweaver');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(dataDirPath, 'not a directory');

    const prompt = vi.fn(async () => true);
    const mkdir = vi.fn();
    const log = vi.fn();

    const result = await runDoctor({ prompt, mkdir, log });

    expect(prompt).not.toHaveBeenCalled();
    expect(mkdir).not.toHaveBeenCalled();
    expect(result).toEqual({ ok: false, failed: 1, exitCode: 1 });

    const summary = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(summary).toMatch(/failed/i);
  });
});
