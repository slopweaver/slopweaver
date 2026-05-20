import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordSendOutcomeArgs, RecordSendOutcomeResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createRecordSendOutcomeTool } from './record-send-outcome.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);

describe('createRecordSendOutcomeTool', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let tempDir: string;
  let logPath: string;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempDir = mkdtempSync(join(tmpdir(), 'slop-sends-'));
    logPath = join(tempDir, 'sends.jsonl');
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends a sent outcome with permalink', async () => {
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: '/tmp/d.md',
        status: 'sent',
        sent_url: 'https://slack.com/archives/C1/p123',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = RecordSendOutcomeResult.parse(result.value);
      expect(parsed.line_number).toBe(1);
    }
    const onDisk = readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(onDisk.trim()) as Record<string, unknown>;
    expect(parsed['status']).toBe('sent');
    expect(parsed['sent_url']).toBe('https://slack.com/archives/C1/p123');
  });

  it('appends a failed outcome with error', async () => {
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: '/tmp/d.md',
        status: 'failed',
        error: 'rate limited',
      }),
      ctx: { db: dbHandle.db },
    });
    const onDisk = readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(onDisk.trim()) as Record<string, unknown>;
    expect(parsed['status']).toBe('failed');
    expect(parsed['error']).toBe('rate limited');
  });

  it('appends a cancelled outcome with neither url nor error', async () => {
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: '/tmp/d.md',
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    const onDisk = readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(onDisk.trim()) as Record<string, unknown>;
    expect(parsed['status']).toBe('cancelled');
    expect(parsed).not.toHaveProperty('sent_url');
    expect(parsed).not.toHaveProperty('error');
  });

  it('appends multiple lines and reports incrementing line numbers', async () => {
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    for (let i = 1; i <= 3; i += 1) {
      const r = await tool.handler({
        input: RecordSendOutcomeArgs.parse({
          draft_path: `/tmp/d${i}.md`,
          status: 'cancelled',
        }),
        ctx: { db: dbHandle.db },
      });
      expect(r.isOk()).toBe(true);
      if (r.isOk()) expect(r.value.line_number).toBe(i);
    }
  });
});
