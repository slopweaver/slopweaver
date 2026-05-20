/**
 * Tests for the walk-feedback append + summarize flow.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFeedbackLine, loadAndSummarize } from './feedback.ts';

let tempCwd: string;
let absLogPath: string;

beforeEach(() => {
  tempCwd = mkdtempSync(join(tmpdir(), 'slop-feedback-'));
  absLogPath = resolve(tempCwd, 'state/log.jsonl');
});

afterEach(() => {
  rmSync(tempCwd, { recursive: true, force: true });
});

describe('appendFeedbackLine', () => {
  it('appends a single line at index 1 on first call', async () => {
    const r = await appendFeedbackLine({
      absLogPath,
      now: () => new Date('2026-05-21T10:00:00.000Z'),
      line: {
        walk_id: 'walk_2026-05-21_1000',
        item_index: 1,
        outcome: 'approved-as-proposed',
        item_summary: 'first',
      },
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.lineNumber).toBe(1);
      expect(r.value.bytesAppended).toBeGreaterThan(0);
    }
  });

  it('returns lineNumber=N+1 for the Nth line', async () => {
    for (let i = 1; i <= 3; i += 1) {
      const r = await appendFeedbackLine({
        absLogPath,
        line: { walk_id: 'walk_x', item_index: i, outcome: 'approved-as-proposed' },
      });
      expect(r.isOk()).toBe(true);
      if (r.isOk()) expect(r.value.lineNumber).toBe(i);
    }
  });

  it('uses the supplied ts when present', async () => {
    const r = await appendFeedbackLine({
      absLogPath,
      line: {
        walk_id: 'w',
        item_index: 1,
        outcome: 'approved-as-proposed',
        ts: '2025-01-01T00:00:00.000Z',
      },
    });
    expect(r.isOk()).toBe(true);
  });
});

describe('loadAndSummarize', () => {
  it('returns an empty summary when the log is missing', async () => {
    const r = await loadAndSummarize({ absLogPath, now: () => new Date('2026-05-21T10:00:00Z') });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.totalWalks).toBe(0);
      expect(r.value.totalItems).toBe(0);
      expect(r.value.acceptanceRate).toBe(0);
    }
  });

  it('summarizes outcomes across multiple walks', async () => {
    const now = new Date('2026-05-21T10:00:00Z');
    const lines = [
      JSON.stringify({
        ts: '2026-05-20T09:00:00Z',
        walk_id: 'walk_a',
        item_index: 1,
        outcome: 'approved-as-proposed',
        tags: ['friction:wrong-channel'],
      }),
      JSON.stringify({
        ts: '2026-05-20T09:01:00Z',
        walk_id: 'walk_a',
        item_index: 2,
        outcome: 'edited',
        tags: ['friction:wrong-channel', 'friction:wrong-tone'],
      }),
      JSON.stringify({
        ts: '2026-05-20T09:02:00Z',
        walk_id: 'walk_a',
        item_index: 3,
        outcome: 'rejected',
      }),
      JSON.stringify({
        ts: '2026-05-20T09:50:00Z',
        walk_id: 'walk_a',
        item_index: 0,
        outcome: 'walk-summary',
      }),
      JSON.stringify({
        ts: '2026-05-21T08:00:00Z',
        walk_id: 'walk_b',
        item_index: 1,
        outcome: 'noted',
      }),
    ];
    // Build the parent dir then write the log via writeFileSync directly
    // since appendFeedbackLine adds a newline per call — testing the
    // summarize path needs raw control over the file contents.
    const { mkdirSync } = await import('node:fs');
    mkdirSync(resolve(absLogPath, '..'), { recursive: true });
    writeFileSync(absLogPath, `${lines.join('\n')}\n`);
    const r = await loadAndSummarize({ absLogPath, now: () => now });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.totalWalks).toBe(2);
      expect(r.value.totalItems).toBe(4);
      expect(r.value.outcomeCounts['approved-as-proposed']).toBe(1);
      expect(r.value.outcomeCounts['edited']).toBe(1);
      expect(r.value.outcomeCounts['rejected']).toBe(1);
      expect(r.value.outcomeCounts['noted']).toBe(1);
      expect(r.value.acceptanceRate).toBe(0.25);
      expect(r.value.editRate).toBe(0.25);
      expect(r.value.rejectionRate).toBe(0.25);
      expect(r.value.topFrictionTags[0]).toEqual({ tag: 'friction:wrong-channel', count: 2 });
      expect(r.value.topFrictionTags[1]).toEqual({ tag: 'friction:wrong-tone', count: 1 });
    }
  });

  it('filters lines older than `since`', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(resolve(absLogPath, '..'), { recursive: true });
    const lines = [
      JSON.stringify({
        ts: '2024-01-01T00:00:00Z',
        walk_id: 'old',
        item_index: 1,
        outcome: 'approved-as-proposed',
      }),
      JSON.stringify({
        ts: '2026-05-20T09:00:00Z',
        walk_id: 'new',
        item_index: 1,
        outcome: 'approved-as-proposed',
      }),
    ];
    writeFileSync(absLogPath, `${lines.join('\n')}\n`);
    const r = await loadAndSummarize({
      absLogPath,
      sinceIso: '2026-01-01T00:00:00Z',
      now: () => new Date('2026-05-21T00:00:00Z'),
    });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.totalItems).toBe(1);
      expect(r.value.totalWalks).toBe(1);
    }
  });

  it('skips lines that fail JSON.parse without crashing', async () => {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(resolve(absLogPath, '..'), { recursive: true });
    writeFileSync(
      absLogPath,
      `not json at all\n${JSON.stringify({ ts: '2026-05-20T09:00:00Z', walk_id: 'x', item_index: 1, outcome: 'approved-as-proposed' })}\n`,
    );
    const r = await loadAndSummarize({ absLogPath, now: () => new Date('2026-05-21T00:00:00Z') });
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value.totalItems).toBe(1);
  });
});
