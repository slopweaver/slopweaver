/**
 * Tests for `buildCalibrationResponse`. Uses a real temp dir + a
 * crafted JSONL file so we exercise the file-read path.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCalibrationResponse, defaultCalibrationLogPath, resolveCalibrationLogPath } from './calibration.ts';

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
    expect(r.source_present).toBe(false);
    expect(r.empty).toBe(true);
    expect(r.by_integration).toEqual([]);
    expect(r.by_kind).toEqual([]);
  });

  it('zero-fills the daily skeleton across the window when the file is missing', () => {
    const sinceMs = Date.UTC(2026, 4, 19, 0, 0, 0);
    const r = buildCalibrationResponse({ logPath, sinceMs, nowMs: FIXED_NOW });
    // 2026-05-19, 2026-05-20, 2026-05-21 inclusive — three UTC days.
    expect(r.daily.length).toBe(3);
    expect(r.daily.map((p) => p.day)).toEqual(['2026-05-19', '2026-05-20', '2026-05-21']);
    expect(r.daily.every((p) => p.total === 0)).toBe(true);
    expect(r.daily.every((p) => p.accept_ratio === 0)).toBe(true);
  });

  it('summarizes outcomes + friction tags + ratios from a real log', () => {
    const lines = [
      JSON.stringify({
        ts: '2026-05-20T09:00:00Z',
        walk_id: 'a',
        outcome: 'approved-as-proposed',
        integration: 'github',
        kind: 'review_request',
        tags: ['friction:wrong-channel'],
      }),
      JSON.stringify({
        ts: '2026-05-20T09:01:00Z',
        walk_id: 'a',
        outcome: 'edited',
        integration: 'github',
        kind: 'review_request',
        tags: ['friction:wrong-channel', 'friction:wrong-tone'],
      }),
      JSON.stringify({
        ts: '2026-05-21T08:00:00Z',
        walk_id: 'b',
        outcome: 'rejected',
        integration: 'slack',
        kind: 'mention',
      }),
      JSON.stringify({ ts: '2026-05-21T08:30:00Z', walk_id: 'b', outcome: 'walk-summary' }),
    ];
    writeFileSync(logPath, `${lines.join('\n')}\n`);

    const r = buildCalibrationResponse({
      logPath,
      sinceMs: Date.UTC(2026, 4, 20, 0, 0, 0),
      nowMs: FIXED_NOW,
    });
    expect(r.total_walks).toBe(2);
    expect(r.total_items).toBe(3);
    expect(r.acceptance_rate).toBeCloseTo(1 / 3, 5);
    expect(r.edit_rate).toBeCloseTo(1 / 3, 5);
    expect(r.rejection_rate).toBeCloseTo(1 / 3, 5);
    expect(r.empty).toBe(false);

    // Two days in the window: 2026-05-20 and 2026-05-21.
    expect(r.daily.length).toBe(2);
    expect(r.daily[0]?.day).toBe('2026-05-20');
    expect(r.daily[0]?.approved).toBe(1);
    expect(r.daily[0]?.edited).toBe(1);
    expect(r.daily[0]?.total).toBe(2);
    expect(r.daily[0]?.accept_ratio).toBeCloseTo(0.5, 5);
    expect(r.daily[0]?.edit_ratio).toBeCloseTo(0.5, 5);
    expect(r.daily[1]?.day).toBe('2026-05-21');
    expect(r.daily[1]?.rejected).toBe(1);
    expect(r.daily[1]?.reject_ratio).toBeCloseTo(1, 5);

    expect(r.by_integration).toEqual([
      { key: 'github', accept: 1, edit: 1, reject: 0 },
      { key: 'slack', accept: 0, edit: 0, reject: 1 },
    ]);
    expect(r.by_kind).toEqual([
      { key: 'review_request', accept: 1, edit: 1, reject: 0 },
      { key: 'mention', accept: 0, edit: 0, reject: 1 },
    ]);

    expect(r.top_friction_tags[0]).toEqual({ tag: 'friction:wrong-channel', count: 2 });
    expect(r.top_friction_tags[1]).toEqual({ tag: 'friction:wrong-tone', count: 1 });
    expect(r.source_present).toBe(true);
  });

  it('uses "unknown" as the breakdown key when integration or kind is missing', () => {
    writeFileSync(
      logPath,
      `${JSON.stringify({ ts: '2026-05-20T09:00:00Z', walk_id: 'a', outcome: 'approved-as-proposed' })}\n`,
    );
    const r = buildCalibrationResponse({
      logPath,
      sinceMs: Date.UTC(2026, 4, 20, 0, 0, 0),
      nowMs: FIXED_NOW,
    });
    expect(r.by_integration).toEqual([{ key: 'unknown', accept: 1, edit: 0, reject: 0 }]);
    expect(r.by_kind).toEqual([{ key: 'unknown', accept: 1, edit: 0, reject: 0 }]);
  });

  it('zero-fills days between events', () => {
    const lines = [
      JSON.stringify({ ts: '2026-05-19T09:00:00Z', walk_id: 'a', outcome: 'approved-as-proposed' }),
      JSON.stringify({ ts: '2026-05-21T09:00:00Z', walk_id: 'b', outcome: 'rejected' }),
    ];
    writeFileSync(logPath, `${lines.join('\n')}\n`);
    const r = buildCalibrationResponse({
      logPath,
      sinceMs: Date.UTC(2026, 4, 19, 0, 0, 0),
      nowMs: FIXED_NOW,
    });
    expect(r.daily.length).toBe(3);
    expect(r.daily[0]?.day).toBe('2026-05-19');
    expect(r.daily[0]?.approved).toBe(1);
    expect(r.daily[1]?.day).toBe('2026-05-20');
    expect(r.daily[1]?.total).toBe(0);
    expect(r.daily[2]?.day).toBe('2026-05-21');
    expect(r.daily[2]?.rejected).toBe(1);
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
    const r = buildCalibrationResponse({
      logPath,
      sinceMs: Date.UTC(2026, 4, 20, 0, 0, 0),
      nowMs: FIXED_NOW,
    });
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

describe('resolveCalibrationLogPath', () => {
  it('prefers an explicit feedbackLogPath argument over env and cwd', () => {
    expect(
      resolveCalibrationLogPath({
        feedbackLogPath: '/explicit/path.jsonl',
        env: { SLOPWEAVER_FEEDBACK_LOG: '/env/path.jsonl' },
        cwd: '/tmp/repo',
      }),
    ).toBe('/explicit/path.jsonl');
  });

  it('falls back to SLOPWEAVER_FEEDBACK_LOG when no explicit path is given', () => {
    expect(
      resolveCalibrationLogPath({
        feedbackLogPath: undefined,
        env: { SLOPWEAVER_FEEDBACK_LOG: '/env/path.jsonl' },
        cwd: '/tmp/repo',
      }),
    ).toBe('/env/path.jsonl');
  });

  it('falls back to the cwd-relative default when neither is set', () => {
    expect(
      resolveCalibrationLogPath({
        feedbackLogPath: undefined,
        env: {},
        cwd: '/tmp/repo',
      }),
    ).toBe('/tmp/repo/.claude/personal/state/lock-in-feedback.jsonl');
  });

  it('treats an empty-string env var as unset', () => {
    expect(
      resolveCalibrationLogPath({
        feedbackLogPath: undefined,
        env: { SLOPWEAVER_FEEDBACK_LOG: '' },
        cwd: '/tmp/repo',
      }),
    ).toBe('/tmp/repo/.claude/personal/state/lock-in-feedback.jsonl');
  });
});
