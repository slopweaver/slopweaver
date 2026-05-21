/**
 * Tests for `start_draft`. The tool is mostly a slug + ID generator
 * plus the instructional body — verify all three plus the wire shape.
 */

import { StartDraftArgs, StartDraftResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStartDraftTool, slugifyAnchor } from './start-draft.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);

describe('slugifyAnchor', () => {
  it.each([
    ['#10407', '10407'],
    ['https://github.com/owner/repo/pull/123', 'https-github-com-owner-repo-pull-123'],
    ['slack:C1234/thread:1234.5678', 'slack-c1234-thread-1234-5678'],
    ['UPPERCASE WITH SPACES', 'uppercase-with-spaces'],
  ])('slugifies %s → %s', (input, expected) => {
    expect(slugifyAnchor(input)).toBe(expected);
  });

  it('returns "untitled" when input is all special chars', () => {
    expect(slugifyAnchor('!!!')).toBe('untitled');
  });

  it('caps the slug at 80 chars', () => {
    const long = 'x'.repeat(100);
    expect(slugifyAnchor(long).length).toBe(80);
  });
});

describe('createStartDraftTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('returns a draft_id, suggested_path, and the instructional body', async () => {
    const tool = createStartDraftTool({
      now: () => FIXED_NOW,
      generateDraftId: () => 'draft_fixed',
    });
    const result = await tool.handler({
      input: StartDraftArgs.parse({
        thread_ref: 'https://github.com/owner/repo/pull/123',
        intent: 'request scope clarification',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = StartDraftResult.parse(result.value);
      expect(parsed.draft_id).toBe('draft_fixed');
      expect(parsed.suggested_path).toBe('drafts/https-github-com-owner-repo-pull-123-draft_fixed.md');
      expect(parsed.instructions).toContain('Draft a reply');
      expect(parsed.instructions).toContain('apply_voice_rules');
      expect(parsed.instructions).toContain('recall');
      expect(parsed.instructions).not.toContain('@everlab');
      expect(parsed.generated_at).toBe(new Date(FIXED_NOW).toISOString());
    }
  });

  it('includes draft_id in the suggested_path so repeat calls do not collide', async () => {
    let counter = 0;
    const tool = createStartDraftTool({
      now: () => FIXED_NOW,
      generateDraftId: () => `draft_${++counter}`,
    });
    const a = await tool.handler({
      input: StartDraftArgs.parse({ thread_ref: 'slack:C123/thread:1.2' }),
      ctx: { db: dbHandle.db },
    });
    const b = await tool.handler({
      input: StartDraftArgs.parse({ thread_ref: 'slack:C123/thread:1.2' }),
      ctx: { db: dbHandle.db },
    });
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    if (a.isOk() && b.isOk()) {
      const pa = StartDraftResult.parse(a.value);
      const pb = StartDraftResult.parse(b.value);
      // The slug anchor is identical (same thread_ref) but the draft_id
      // suffix differs, so the two paths can't collide on disk.
      expect(pa.suggested_path).toBe('drafts/slack-c123-thread-1-2-draft_1.md');
      expect(pb.suggested_path).toBe('drafts/slack-c123-thread-1-2-draft_2.md');
      expect(pa.suggested_path).not.toBe(pb.suggested_path);
      expect(pa.suggested_path).toContain(pa.draft_id);
      expect(pb.suggested_path).toContain(pb.draft_id);
    }
  });

  it('enumerates the supported target: shapes (pull, not pulls)', async () => {
    const tool = createStartDraftTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: StartDraftArgs.parse({ thread_ref: 'x' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = StartDraftResult.parse(result.value);
      // Must match send_via_source's parse-target.ts shape (PR #72).
      expect(parsed.instructions).toContain('github:<owner>/<repo>/pull/<number>');
      expect(parsed.instructions).toContain('github:<owner>/<repo>/issue/<number>');
      expect(parsed.instructions).toContain('slack:<channel_id>/thread:<thread_ts>');
      expect(parsed.instructions).toContain('gmail:<thread_id>');
      // Linear support landed in PR #72's parse-target.ts; the draft
      // instructions must enumerate it so the model knows to emit it.
      expect(parsed.instructions).toContain('linear:<issue_id>');
      // The wrong shape must NOT appear in the canonical enumeration.
      expect(parsed.instructions).not.toContain('github:owner/repo/pulls/');
    }
  });

  it('documents fail-closed / continue-with-warning failure modes', async () => {
    const tool = createStartDraftTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: StartDraftArgs.parse({ thread_ref: 'x' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const body = StartDraftResult.parse(result.value).instructions;
      // Source thread MCP missing → fail closed.
      expect(body).toContain('Failure mode — missing source MCP');
      expect(body).toContain('fail closed');
      // recall missing → continue with note.
      expect(body).toContain('Failure mode — `recall` not available');
      expect(body).toContain('continue without it');
      // apply_voice_rules missing → continue with warning.
      expect(body).toContain('Failure mode — `apply_voice_rules` not available');
      expect(body).toContain('lint skipped');
      // write_console_file missing → return inline.
      expect(body).toContain('Failure mode — `write_console_file` not available');
      expect(body).toContain('return the full draft body');
    }
  });

  it('honours the optional intent argument by ignoring it in the body', async () => {
    const tool = createStartDraftTool({ now: () => FIXED_NOW });
    const a = await tool.handler({
      input: StartDraftArgs.parse({ thread_ref: 'x', intent: 'foo' }),
      ctx: { db: dbHandle.db },
    });
    const b = await tool.handler({
      input: StartDraftArgs.parse({ thread_ref: 'x', intent: 'bar' }),
      ctx: { db: dbHandle.db },
    });
    // The instructional body is constant; intent is a runtime hint the
    // model uses but isn't substituted into the template.
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    if (a.isOk() && b.isOk()) {
      const pa = StartDraftResult.parse(a.value);
      const pb = StartDraftResult.parse(b.value);
      expect(pa.instructions).toBe(pb.instructions);
    }
  });

  it('generates distinct draft_ids by default using crypto.randomUUID (no collisions)', async () => {
    const tool = createStartDraftTool({ now: () => FIXED_NOW });
    const a = await tool.handler({
      input: StartDraftArgs.parse({ thread_ref: 'x' }),
      ctx: { db: dbHandle.db },
    });
    const b = await tool.handler({
      input: StartDraftArgs.parse({ thread_ref: 'x' }),
      ctx: { db: dbHandle.db },
    });
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    if (a.isOk() && b.isOk()) {
      const pa = StartDraftResult.parse(a.value);
      const pb = StartDraftResult.parse(b.value);
      expect(pa.draft_id).not.toBe(pb.draft_id);
      // RFC 4122 v4 — `draft_<8>-<4>-<4>-<4>-<12>` hex with version
      // nibble `4` and variant nibble `8/9/a/b`. Pin the shape so a
      // future regression to `Math.random()` (which gave only ~36 bits
      // of entropy and allowed collisions) is caught here.
      const uuidV4Re = /^draft_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      expect(pa.draft_id).toMatch(uuidV4Re);
      expect(pb.draft_id).toMatch(uuidV4Re);
    }
  });

  it('large batch of default draft_ids has zero collisions (UUID v4 entropy)', async () => {
    // With Math.random() at 6 base36 chars (~36 bits), birthday-paradox
    // collisions show up in the low-thousands range. UUID v4 has ~122
    // bits, so 1000 generations should still be entirely distinct.
    const tool = createStartDraftTool({ now: () => FIXED_NOW });
    const ids = new Set<string>();
    for (let i = 0; i < 1000; i += 1) {
      const r = await tool.handler({
        input: StartDraftArgs.parse({ thread_ref: 'x' }),
        ctx: { db: dbHandle.db },
      });
      expect(r.isOk()).toBe(true);
      if (r.isOk()) {
        ids.add(StartDraftResult.parse(r.value).draft_id);
      }
    }
    expect(ids.size).toBe(1000);
  });
});
