/**
 * Tests for the companion-file response builder. Uses a real temp dir
 * so we exercise the actual filesystem path (the contract is "a JSONL
 * line lands at `<cwd>/.claude/personal/state/companion-inbox.jsonl`").
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCompanionFileResponse } from './companion.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);

describe('buildCompanionFileResponse', () => {
  let tempCwd: string;

  beforeEach(() => {
    tempCwd = mkdtempSync(join(tmpdir(), 'slop-companion-'));
  });

  afterEach(() => {
    rmSync(tempCwd, { recursive: true, force: true });
  });

  it('appends a valid payload as JSONL and reports line_number=1 on first call', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { url: 'https://github.com/o/r/pull/1', title: 'PR #1' },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(true);
    if (result.filed) {
      expect(result.line_number).toBe(1);
      expect(result.path).toBe(join(tempCwd, '.claude/personal/state/companion-inbox.jsonl'));
      const onDisk = readFileSync(result.path, 'utf-8');
      const parsed = JSON.parse(onDisk.trim()) as Record<string, unknown>;
      expect(parsed['url']).toBe('https://github.com/o/r/pull/1');
      expect(parsed['title']).toBe('PR #1');
      expect(parsed['ts']).toBe(new Date(FIXED_NOW).toISOString());
    }
  });

  it('appends subsequent entries with incrementing line numbers', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const r = await buildCompanionFileResponse({
        cwd: tempCwd,
        payload: { url: `https://example.com/${i}`, title: `entry ${i}` },
        nowMs: FIXED_NOW,
      });
      expect(r.filed).toBe(true);
      if (r.filed) expect(r.line_number).toBe(i);
    }
  });

  it('returns filed:false with an error for an invalid payload', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { url: '' },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
    if (!result.filed) expect(result.error).toContain('url');
  });

  it('returns filed:false when payload is not an object', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: 'just a string',
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
  });

  it('returns filed:false when payload is null', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: null,
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
    if (!result.filed) expect(result.error).toContain('object');
  });

  it('returns filed:false when url is missing', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { title: 'orphan' },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
    if (!result.filed) expect(result.error).toContain('url');
  });

  it('returns filed:false when title is missing', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { url: 'https://example.com/x' },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
    if (!result.filed) expect(result.error).toContain('title');
  });

  it.each([
    ['javascript:alert(1)', 'javascript'],
    ['data:text/html,<script>alert(1)</script>', 'data'],
    ['file:///etc/passwd', 'file'],
    ['ftp://example.com/x', 'ftp'],
    ['chrome://settings', 'chrome'],
  ])('rejects non-http(s) URL scheme %s', async (url) => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { url, title: 'evil' },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
    if (!result.filed) expect(result.error).toContain('http');
  });

  it('rejects URLs that fail to parse', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { url: 'not a url', title: 'x' },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
    if (!result.filed) expect(result.error.toLowerCase()).toContain('url');
  });

  it('rejects URLs exceeding the length cap', async () => {
    const longUrl = `https://example.com/${'a'.repeat(2100)}`;
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { url: longUrl, title: 'x' },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
    if (!result.filed) expect(result.error).toContain('2048');
  });

  it('rejects titles exceeding the length cap', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { url: 'https://example.com/x', title: 'a'.repeat(600) },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(false);
    if (!result.filed) expect(result.error).toContain('512');
  });

  it('accepts http URLs (not just https)', async () => {
    const result = await buildCompanionFileResponse({
      cwd: tempCwd,
      payload: { url: 'http://127.0.0.1:8080/x', title: 'local' },
      nowMs: FIXED_NOW,
    });
    expect(result.filed).toBe(true);
  });
});
