/**
 * Tests for the audit-progress JSONL append. Uses a real temp dir +
 * logPathOverride so we don't touch the user's actual data dir.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordAuditProgressArgs, RecordAuditProgressResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecordAuditProgressTool } from './record-audit-progress.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);

describe('createRecordAuditProgressTool', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempDir = mkdtempSync(join(tmpdir(), 'slop-mega-audit-'));
    logPath = join(tempDir, 'audit-progress.jsonl');
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the log file on first call and reports line_number=1', async () => {
    const tool = createRecordAuditProgressTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordAuditProgressArgs.parse({
        audit_id: 'audit_x',
        phase: 'starting',
        message: 'audit kicked off',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = RecordAuditProgressResult.parse(result.value);
      expect(parsed.log_path).toBe(logPath);
      expect(parsed.line_number).toBe(1);
      expect(parsed.bytes_appended).toBeGreaterThan(0);
    }
    const onDisk = readFileSync(logPath, 'utf-8');
    const lines = onDisk.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['audit_id']).toBe('audit_x');
    expect(parsed['phase']).toBe('starting');
    expect(parsed['message']).toBe('audit kicked off');
    expect(parsed['ts']).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('appends subsequent events with incrementing line numbers', async () => {
    const tool = createRecordAuditProgressTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    for (let i = 1; i <= 3; i += 1) {
      const r = await tool.handler({
        input: RecordAuditProgressArgs.parse({
          audit_id: 'audit_x',
          phase: 'polling',
          source: 'slack',
          message: `iter ${i}`,
          pct: i * 25,
        }),
        ctx: { db: dbHandle.db },
      });
      expect(r.isOk()).toBe(true);
      if (r.isOk()) expect(r.value.line_number).toBe(i);
    }
    const onDisk = readFileSync(logPath, 'utf-8');
    const lines = onDisk.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const last = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(last['pct']).toBe(75);
    expect(last['source']).toBe('slack');
  });

  it('omits optional fields when not supplied', async () => {
    const tool = createRecordAuditProgressTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    await tool.handler({
      input: RecordAuditProgressArgs.parse({
        audit_id: 'audit_x',
        phase: 'inventory',
        message: 'no source, no pct',
      }),
      ctx: { db: dbHandle.db },
    });
    const onDisk = readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(onDisk.trim()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('source');
    expect(parsed).not.toHaveProperty('pct');
  });
});
