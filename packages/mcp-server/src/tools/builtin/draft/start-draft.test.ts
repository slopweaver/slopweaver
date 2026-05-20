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
      expect(parsed.suggested_path).toBe('drafts/https-github-com-owner-repo-pull-123.md');
      expect(parsed.instructions).toContain('Draft a reply');
      expect(parsed.instructions).toContain('apply_voice_rules');
      expect(parsed.instructions).toContain('recall');
      expect(parsed.instructions).not.toContain('@everlab');
      expect(parsed.generated_at).toBe(new Date(FIXED_NOW).toISOString());
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
      expect(a.value.instructions).toBe(b.value.instructions);
    }
  });

  it('generates distinct draft_ids by default', async () => {
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
      expect(a.value.draft_id).not.toBe(b.value.draft_id);
    }
  });
});
