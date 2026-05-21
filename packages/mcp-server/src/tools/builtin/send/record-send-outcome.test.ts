import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordSendOutcomeArgs, RecordSendOutcomeResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashContent, parseFrontmatter } from './parse-frontmatter.ts';
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
    return hashContent({ frontmatter: parsed.frontmatter, body: parsed.body });
  }

  it('appends a sent outcome with permalink and rewrites the draft status', async () => {
    const hash = seedDraft({ draftId: 'd1', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        content_hash: hash,
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
    expect(parsed['content_hash']).toBe(hash);

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
        content_hash: hash,
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
        content_hash: hash,
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
        content_hash: hash,
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('draft_id mismatch');
  });

  it('rejects when content_hash does not match the on-disk content', async () => {
    seedDraft({ draftId: 'd1', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        content_hash: 'deadbeefdeadbeef',
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('content_hash mismatch');
  });

  /**
   * Iter-3 P1: drift detection must cover body, not just frontmatter.
   * If the body changes on disk between prepare_send and
   * record_send_outcome, the previously-issued content_hash must no
   * longer match — otherwise calibration data would log an outcome
   * against a draft body the model didn't actually approve to send.
   */
  it('rejects when only the body has drifted (body is part of content_hash)', async () => {
    const originalHash = seedDraft({ draftId: 'd1', target: 'slack:C1', body: 'original body text' });
    // Rewrite the draft body but keep frontmatter intact.
    const drifted = '---\ndraft_id: d1\ntarget: slack:C1\n---\nEDITED body text\n';
    writeFileSync(draftPath, drifted, 'utf-8');

    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        content_hash: originalHash,
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('content_hash mismatch');
  });

  it('rejects an attempt to overwrite a terminal status with a different one', async () => {
    const hash = seedDraft({ draftId: 'd1', target: 'slack:C1', status: 'sent' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const result = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        content_hash: hash,
        status: 'failed',
        error: 'after-the-fact',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('already has terminal status');
  });

  /**
   * Iter-3 P1: idempotent on (draft_id, status, content_hash). A
   * retry after the model loses the first response (transport
   * ambiguity, network blip) must NOT append a duplicate JSONL row —
   * the calibration loop would otherwise double-count send outcomes.
   * The second call returns the existing line_number unchanged and
   * does not write to disk.
   */
  it('is idempotent when called twice with the same (draft_id, status, content_hash)', async () => {
    const hash = seedDraft({ draftId: 'd1', target: 'slack:C1' });
    const tool = createRecordSendOutcomeTool({ logPathOverride: logPath, now: () => FIXED_NOW });
    const first = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        content_hash: hash,
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(first.isOk()).toBe(true);
    if (!first.isOk()) return;
    const firstLine = first.value['line_number'];
    expect(firstLine).toBe(1);

    const second = await tool.handler({
      input: RecordSendOutcomeArgs.parse({
        draft_path: draftPath,
        draft_id: 'd1',
        content_hash: hash,
        status: 'cancelled',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(second.isOk()).toBe(true);
    if (second.isOk()) expect(second.value['line_number']).toBe(firstLine);

    // On disk there should still be exactly one JSONL row — no duplicate.
    const onDisk = readFileSync(logPath, 'utf-8');
    const rows = onDisk.split('\n').filter((l) => l.trim().length > 0);
    expect(rows.length).toBe(1);
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
          content_hash: hash,
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
      content_hash: 'abcdef0123456789',
      status: 'sent',
      // sent_url omitted
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the Zod schema for status=failed without error', () => {
    const parsed = RecordSendOutcomeArgs.safeParse({
      draft_path: '/tmp/d.md',
      draft_id: 'd1',
      content_hash: 'abcdef0123456789',
      status: 'failed',
      // error omitted
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects the Zod schema for status=cancelled with extraneous sent_url', () => {
    const parsed = RecordSendOutcomeArgs.safeParse({
      draft_path: '/tmp/d.md',
      draft_id: 'd1',
      content_hash: 'abcdef0123456789',
      status: 'cancelled',
      sent_url: 'https://slack.com/x',
    });
    // `.strict()` on the cancelled variant rejects unknown keys.
    expect(parsed.success).toBe(false);
  });
});
