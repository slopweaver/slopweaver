import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordSendOutcomeArgs, RecordSendOutcomeResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashFrontmatter, parseFrontmatter } from './parse-frontmatter.ts';
import { createRecordSendOutcomeTool } from './record-send-outcome.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);

describe('createRecordSendOutcomeTool', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let tempDir: string;
  let logPath: string;
  let draftPath: string;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempDir = mkdtempSync(join(tmpdir(), 'slop-sends-'));
    logPath = join(tempDir, 'sends.jsonl');
    draftPath = join(tempDir, 'draft.md');
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  /** Helper: write a draft with the canonical frontmatter shape and return the matching hash. */
  function seedDraft({
    draftId,
    target,
    body = 'reply body',
    status,
  }: {
    draftId: string;
    target: string;
    body?: string;
    status?: string;
  }): string {
    const fmLines: string[] = [`draft_id: ${draftId}`, `target: ${target}`];
    if (status != null) fmLines.push(`status: ${status}`);
    const content = `---\n${fmLines.join('\n')}\n---\n${body}\n`;
    writeFileSync(draftPath, content, 'utf-8');
    const parsed = parseFrontmatter({ input: content });
    if (parsed === null) throw new Error('seedDraft produced unparseable content');
    return hashFrontmatter({ frontmatter: parsed.frontmatter });
  }

  it('appends a sent outcome with permalink and rewrites the draft status', async () => {
    const hash = seedDraft({ draftId: 'd1', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        frontmatter_hash: hash,
        status: 'sent',
        sent_url: 'https://slack.com/archives/C1/p123',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = RecordSendOutcomeResult.parse(result.value);
      expect(parsed.line_number).toBe(1);
      expect(parsed.draft_status).toBe('sent');
    }

    const onDisk = readFileSync(logPath, 'utf-8');
    const parsed = JSON.parse(onDisk.trim()) as Record<string, unknown>;
    expect(parsed['status']).toBe('sent');
    expect(parsed['sent_url']).toBe('https://slack.com/archives/C1/p123');
    expect(parsed['draft_id']).toBe('d1');
    expect(parsed['frontmatter_hash']).toBe(hash);

    // The draft on disk has been atomically rewritten to include `status: sent`.
    const updatedDraft = readFileSync(draftPath, 'utf-8');
    const updatedParsed = parseFrontmatter({ input: updatedDraft });
    expect(updatedParsed?.frontmatter['status']).toBe('sent');
    expect(updatedParsed?.frontmatter['draft_id']).toBe('d1');
    expect(updatedParsed?.frontmatter['target']).toBe('slack:C1');
  });

  it('appends a failed outcome with error', async () => {
    const hash = seedDraft({ draftId: 'd1', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        frontmatter_hash: hash,
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
    const hash = seedDraft({ draftId: 'd1', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        frontmatter_hash: hash,
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

  it('rejects when draft_id on disk does not match input', async () => {
    const hash = seedDraft({ draftId: 'on-disk', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'different',
        frontmatter_hash: hash,
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('draft_id mismatch');
  });

  it('rejects when frontmatter_hash does not match the on-disk frontmatter', async () => {
    seedDraft({ draftId: 'd1', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        frontmatter_hash: 'deadbeefdeadbeef',
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('frontmatter_hash mismatch');
  });

  it('rejects an attempt to overwrite a terminal status with a different one', async () => {
    const hash = seedDraft({ draftId: 'd1', target: 'slack:C1', status: 'sent' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        frontmatter_hash: hash,
        status: 'failed',
        error: 'after-the-fact',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('already has terminal status');
  });

  it('is idempotent when called twice with the same terminal status', async () => {
    const hash = seedDraft({ draftId: 'd1', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const first = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        frontmatter_hash: hash,
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(first.isOk()).toBe(true);

    const second = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        frontmatter_hash: hash,
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(second.isOk()).toBe(true);
    if (second.isOk()) expect(second.value['line_number']).toBe(2);
  });

  it('appends multiple lines and reports incrementing line numbers', async () => {
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    for (let i = 1; i <= 3; i += 1) {
      // Each iteration overwrites the draft (the previous record_send_outcome
      // added `status: cancelled`, which is then re-applied in this loop).
      const hash = seedDraft({ draftId: `d${i}`, target: 'slack:C1' });
      const r = await tool.handler({
        input: RecordSendOutcomeArgs.parse({
          draft_path: draftPath,
          draft_id: `d${i}`,
          frontmatter_hash: hash,
          status: 'cancelled',
        }),
        ctx: { db: dbHandle.db },
      });
      expect(r.isOk()).toBe(true);
      if (r.isOk()) expect(r.value['line_number']).toBe(i);
    }
  });

  it('rejects the Zod schema for status=sent without sent_url', () => {
    const parsed = RecordSendOutcomeArgs.safeParse({
      draft_path: '/tmp/d.md',
      draft_id: 'd1',
      frontmatter_hash: 'abcdef0123456789',
      status: 'sent',
      // sent_url omitted
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the Zod schema for status=failed without error', () => {
    const parsed = RecordSendOutcomeArgs.safeParse({
      draft_path: '/tmp/d.md',
      draft_id: 'd1',
      frontmatter_hash: 'abcdef0123456789',
      status: 'failed',
      // error omitted
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the Zod schema for status=cancelled with extraneous sent_url', () => {
    const parsed = RecordSendOutcomeArgs.safeParse({
      draft_path: '/tmp/d.md',
      draft_id: 'd1',
      frontmatter_hash: 'abcdef0123456789',
      status: 'cancelled',
      sent_url: 'https://slack.com/x',
    });
    // `.strict()` on the cancelled variant rejects unknown keys.
    expect(parsed.success).toBe(false);
  });
});
