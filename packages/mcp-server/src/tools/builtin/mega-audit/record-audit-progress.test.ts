/**
 * Tests for the audit-progress JSONL append. Uses a real temp dir +
 * logDirOverride so we don't touch the user's actual data dir.
 *
 * Layout under test: one file per `audit_id` at
 * `<logDir>/<audit_id>.jsonl`. Concurrent audits write to distinct
 * files, so the race between read-modify-write that the previous
 * shared-file layout had is gone by construction.
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

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempDir = mkdtempSync(join(tmpdir(), 'slop-mega-audit-'));
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates the log file on first call and reports line_number=1', async () => {
    const tool = createRecordAuditProgressTool({ logDirOverride: tempDir, now: () => FIXED_NOW });
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
      expect(parsed.log_path).toBe(join(tempDir, 'audit_x.jsonl'));
      expect(parsed.line_number).toBe(1);
      expect(parsed.bytes_appended).toBeGreaterThan(0);
    }
    const onDisk = readFileSync(join(tempDir, 'audit_x.jsonl'), 'utf-8');
    const lines = onDisk.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['audit_id']).toBe('audit_x');
    expect(parsed['phase']).toBe('starting');
    expect(parsed['message']).toBe('audit kicked off');
    expect(parsed['ts']).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('appends subsequent events with incrementing line numbers', async () => {
    const tool = createRecordAuditProgressTool({ logDirOverride: tempDir, now: () => FIXED_NOW });
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
      if (r.isOk()) expect(r.value['line_number']).toBe(i);
    }
    const onDisk = readFileSync(join(tempDir, 'audit_x.jsonl'), 'utf-8');
    const lines = onDisk.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    const last = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(last['pct']).toBe(75);
    expect(last['source']).toBe('slack');
  });

  it('omits optional fields when not supplied', async () => {
    const tool = createRecordAuditProgressTool({ logDirOverride: tempDir, now: () => FIXED_NOW });
    await tool.handler({
      input: RecordAuditProgressArgs.parse({
        audit_id: 'audit_x',
        phase: 'inventory',
        message: 'no source, no pct',
      }),
      ctx: { db: dbHandle.db },
    });
    const onDisk = readFileSync(join(tempDir, 'audit_x.jsonl'), 'utf-8');
    const parsed = JSON.parse(onDisk.trim()) as Record<string, unknown>;
    expect(parsed).not.toHaveProperty('source');
    expect(parsed).not.toHaveProperty('pct');
  });

  it('isolates concurrent audits into distinct files', async () => {
    // Two audits, interleaved appends, must not corrupt each other's
    // line numbers — the read-modify-write bug in the previous
    // implementation would scramble these.
    const tool = createRecordAuditProgressTool({ logDirOverride: tempDir, now: () => FIXED_NOW });

    const writeEvent = async (auditId: string, i: number) =>
      tool.handler({
        input: RecordAuditProgressArgs.parse({
          audit_id: auditId,
          phase: 'aggregating',
          message: `${auditId} step ${i}`,
        }),
        ctx: { db: dbHandle.db },
      });

    // Interleaved concurrent appends — the test asserts each audit's
    // own line numbers are dense (1..N) regardless of interleaving.
    const all = await Promise.all([
      writeEvent('audit_a', 1),
      writeEvent('audit_b', 1),
      writeEvent('audit_a', 2),
      writeEvent('audit_b', 2),
      writeEvent('audit_a', 3),
      writeEvent('audit_b', 3),
    ]);
    for (const r of all) expect(r.isOk()).toBe(true);

    const aLines = readFileSync(join(tempDir, 'audit_a.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    const bLines = readFileSync(join(tempDir, 'audit_b.jsonl'), 'utf-8')
      .split('\n')
      .filter((l) => l.length > 0);
    expect(aLines.length).toBe(3);
    expect(bLines.length).toBe(3);
    // Every line in audit_a's file carries audit_id "audit_a" (no
    // bleed from audit_b), and vice versa.
    for (const l of aLines) {
      const parsed = JSON.parse(l) as Record<string, unknown>;
      expect(parsed['audit_id']).toBe('audit_a');
    }
    for (const l of bLines) {
      const parsed = JSON.parse(l) as Record<string, unknown>;
      expect(parsed['audit_id']).toBe('audit_b');
    }
  });

  it('rejects audit_id values that could escape the audit-progress directory', async () => {
    const tool = createRecordAuditProgressTool({ logDirOverride: tempDir, now: () => FIXED_NOW });
    // Zod schema only enforces non-empty + string; the file-system
    // safety check lives in the handler. Use the parser-bypass shape
    // (raw object) to confirm the handler-level guard fires.
    const result = await tool.handler({
      // Zod's RecordAuditProgressArgs would already reject this, but
      // the handler-level guard is the actual defense — pass through
      // the literal so the handler runs the check itself.
      input: {
        audit_id: '../escape',
        phase: 'starting',
        message: 'attempt path traversal',
      },
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
  });
});
