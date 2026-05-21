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

  it('creates the log file on first call and appends the event to the file', async () => {
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
      expect(parsed.bytes_appended).toBeGreaterThan(0);
    }
    // Verify the appended row is present in the file. The tool no
    // longer returns a line index (that's racy under same-audit
    // parallel calls); the contract is just "the row landed in the
    // file." Locate it by audit_id + ts.
    const onDisk = readFileSync(join(tempDir, 'audit_x.jsonl'), 'utf-8');
    const lines = onDisk.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['audit_id']).toBe('audit_x');
    expect(parsed['phase']).toBe('starting');
    expect(parsed['message']).toBe('audit kicked off');
    expect(parsed['ts']).toBe(new Date(FIXED_NOW).toISOString());
  });

  it('appends subsequent events to the same file in call order', async () => {
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
    }
    const onDisk = readFileSync(join(tempDir, 'audit_x.jsonl'), 'utf-8');
    const lines = onDisk.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(3);
    // Sequential awaited calls land in order — concurrent ones aren't
    // guaranteed to (see "appends every event under same-audit
    // parallel calls" below), but this loop awaits each.
    const last = JSON.parse(lines[2]!) as Record<string, unknown>;
    expect(last['pct']).toBe(75);
    expect(last['source']).toBe('slack');
    const first = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(first['message']).toBe('iter 1');
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
    // files. Per-audit_id filename means there's no shared file to
    // race on.
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

  it('appends every event under same-audit parallel calls', async () => {
    // Same-audit fan-out: ~10 callers append concurrently to the same
    // <audit_id>.jsonl. O_APPEND guarantees each event's bytes land
    // contiguously at end-of-file (writes are <PIPE_BUF), so the file
    // must contain exactly 10 rows after all promises settle. This is
    // the regression the iter-2 audit caught: a previous version
    // returned a `line_number` derived from a post-write read of the
    // file, which two concurrent appenders could observe identically.
    // Dropping `line_number` from the contract removes the racy
    // observation; the per-call promise still resolves once its own
    // O_APPEND write has landed.
    const tool = createRecordAuditProgressTool({ logDirOverride: tempDir, now: () => FIXED_NOW });
    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_unused, i) =>
        tool.handler({
          input: RecordAuditProgressArgs.parse({
            audit_id: 'audit_parallel',
            phase: 'polling',
            source: 'slack',
            message: `parallel ${i}`,
          }),
          ctx: { db: dbHandle.db },
        }),
      ),
    );
    for (const r of results) expect(r.isOk()).toBe(true);

    const onDisk = readFileSync(join(tempDir, 'audit_parallel.jsonl'), 'utf-8');
    const lines = onDisk.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(N);
    // Every line is a complete, parseable JSON object — no torn writes.
    const messages = new Set<string>();
    for (const l of lines) {
      const parsed = JSON.parse(l) as Record<string, unknown>;
      expect(parsed['audit_id']).toBe('audit_parallel');
      expect(typeof parsed['message']).toBe('string');
      messages.add(parsed['message'] as string);
    }
    // All 10 distinct messages are present (none lost, none duplicated).
    expect(messages.size).toBe(N);
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
