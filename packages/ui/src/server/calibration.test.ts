/**
 * Tests for `buildCalibrationResponse`. Uses a real temp dir + a
 * crafted JSONL file so we exercise the file-read path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCalibrationResponse, defaultCalibrationLogPath } from './calibration.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);

describe('buildCalibrationResponse', () => {
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'slop-calibration-'));
    logPath = join(tempDir, 'log.jsonl');
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns an all-zeros response with source_present=false when the file is missing', () => {
    const r = buildCalibrationResponse({ logPath, nowMs: FIXED_NOW });
    expect(r.total_walks).toBe(0);
    expect(r.total_items).toBe(0);
    expect(r.acceptance_rate).toBe(0);
    expect(r.daily).toEqual([]);
    expect(r.source_present).toBe(false);
  });

  it('summarizes outcomes + friction tags from a real log', () => {
    const lines = [
      JSON.stringify({
        ts: '2026-05-20T09:00:00Z',
        walk_id: 'a',
        outcome: 'approved-as-proposed',
        tags: ['friction:wrong-channel'],
      }),
      JSON.stringify({
        ts: '2026-05-20T09:01:00Z',
        walk_id: 'a',
        outcome: 'edited',
        tags: ['friction:wrong-channel', 'friction:wrong-tone'],
      }),
      JSON.stringify({ ts: '2026-05-21T08:00:00Z', walk_id: 'b', outcome: 'rejected' }),
      JSON.stringify({ ts: '2026-05-21T08:30:00Z', walk_id: 'b', outcome: 'walk-summary' }),
    ];
    writeFileSync(logPath, `${lines.join('\n')}\n`);

    const r = buildCalibrationResponse({ logPath, nowMs: FIXED_NOW });
    expect(r.total_walks).toBe(2);
    expect(r.total_items).toBe(3);
    expect(r.acceptance_rate).toBeCloseTo(1 / 3, 5);
    expect(r.edit_rate).toBeCloseTo(1 / 3, 5);
    expect(r.rejection_rate).toBeCloseTo(1 / 3, 5);
    expect(r.daily.length).toBe(2);
    expect(r.daily[0]?.day).toBe('2026-05-20');
    expect(r.daily[0]?.approved).toBe(1);
    expect(r.daily[0]?.edited).toBe(1);
    expect(r.daily[1]?.day).toBe('2026-05-21');
    expect(r.daily[1]?.rejected).toBe(1);
    expect(r.top_friction_tags[0]).toEqual({ tag: 'friction:wrong-channel', count: 2 });
    expect(r.top_friction_tags[1]).toEqual({ tag: 'friction:wrong-tone', count: 1 });
    expect(r.source_present).toBe(true);
  });

  it('filters lines older than the since cutoff', () => {
    const lines = [
      JSON.stringify({ ts: '2024-01-01T00:00:00Z', walk_id: 'old', outcome: 'approved-as-proposed' }),
      JSON.stringify({ ts: '2026-05-20T09:00:00Z', walk_id: 'new', outcome: 'approved-as-proposed' }),
    ];
    writeFileSync(logPath, `${lines.join('\n')}\n`);
    const r = buildCalibrationResponse({
      logPath,
      sinceMs: Date.UTC(2026, 0, 1),
      nowMs: FIXED_NOW,
    });
    expect(r.total_walks).toBe(1);
    expect(r.total_items).toBe(1);
  });

  it('survives malformed JSON lines', () => {
    writeFileSync(
      logPath,
      'not json\n' + JSON.stringify({ ts: '2026-05-20T09:00:00Z', walk_id: 'a', outcome: 'noted' }) + '\n',
    );
    const r = buildCalibrationResponse({ logPath, nowMs: FIXED_NOW });
    expect(r.total_items).toBe(1);
  });
});

describe('defaultCalibrationLogPath', () => {
  it('joins the cwd with the documented relative path', () => {
    expect(defaultCalibrationLogPath({ cwd: '/tmp/repo' })).toBe(
      '/tmp/repo/.claude/personal/state/lock-in-feedback.jsonl',
    );
  });
});
