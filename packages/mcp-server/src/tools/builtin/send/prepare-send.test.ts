/**
 * End-to-end tests for the prepare_send tool. Uses an injected
 * fake-fs reader so we don't need a real file on disk.
 */

import { PrepareSendArgs, PrepareSendResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPrepareSendTool } from './prepare-send.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);

describe('createPrepareSendTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  function makeReader(content: string): (p: string) => Promise<string> {
    return async () => content;
  }

  it('returns routing metadata + token but NO tool_args on the unconfirmed first call', async () => {
    const draft = '---\ndraft_id: d1\ntarget: slack:C123/thread:1234.5678\n---\nHey, picking this back up.\n';
    const tool = createPrepareSendTool({ now: () => FIXED_NOW, readFileImpl: makeReader(draft) });
    const result = await tool.handler({
      input: PrepareSendArgs.parse({ draft_path: '/tmp/drafts/d1.md' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = PrepareSendResult.parse(result.value);
      expect(parsed.draft_id).toBe('d1');
      expect(parsed.target).toEqual({
        platform: 'slack',
        channel: 'C123',
        thread_ts: '1234.5678',
      });
      expect(parsed.body).toBe('Hey, picking this back up.');
      expect(parsed.server).toBe('slack');
      expect(parsed.tool_name).toBe('slack_send_message');
      expect(parsed.requires_confirmation).toBe(true);
      expect(parsed.tool_args).toBeUndefined();
      expect(parsed.confirmation_token.length).toBeGreaterThan(0);
      expect(parsed.content_hash.length).toBeGreaterThan(0);
      expect(parsed.instructions).toContain('5 seconds');
      expect(parsed.instructions).toContain('undo');
      expect(parsed.instructions).toContain('confirmed: true');
    }
  });

  it('returns tool_args on the confirmed second call when the token matches', async () => {
    const draft = '---\ndraft_id: d1\ntarget: slack:C123/thread:1234.5678\n---\nHey, picking this back up.\n';
    const tool = createPrepareSendTool({ now: () => FIXED_NOW, readFileImpl: makeReader(draft) });
    const first = await tool.handler({
      input: PrepareSendArgs.parse({ draft_path: '/tmp/drafts/d1.md' }),
      ctx: { db: dbHandle.db },
    });
    expect(first.isOk()).toBe(true);
    if (!first.isOk()) return;
    const firstParsed = PrepareSendResult.parse(first.value);

    const second = await tool.handler({
      input: PrepareSendArgs.parse({
        draft_path: '/tmp/drafts/d1.md',
        confirmed: true,
        confirmation_token: firstParsed.confirmation_token,
      }),
      ctx: { db: dbHandle.db },
    });
    expect(second.isOk()).toBe(true);
    if (second.isOk()) {
      const parsed = PrepareSendResult.parse(second.value);
      expect(parsed.requires_confirmation).toBe(false);
      expect(parsed.tool_args).toEqual({
        channel_id: 'C123',
        thread_ts: '1234.5678',
        text: 'Hey, picking this back up.',
      });
      expect(parsed.instructions).toContain('mcp__slack__slack_send_message');
      expect(parsed.instructions).toContain('record_send_outcome');
      expect(parsed.instructions).toContain(parsed.content_hash);
    }
  });

  it('rejects a confirmed call with a mismatching token', async () => {
    const draft = '---\ndraft_id: d1\ntarget: slack:C123\n---\nbody\n';
    const tool = createPrepareSendTool({ now: () => FIXED_NOW, readFileImpl: makeReader(draft) });
    const result = await tool.handler({
      input: PrepareSendArgs.parse({
        draft_path: '/tmp/d.md',
        confirmed: true,
        confirmation_token: 'not-the-real-token',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('confirmation_token mismatch');
  });

  /**
   * Iter-3 P1: confirmation token must cover body drift. If the body
   * changes between the unconfirmed and confirmed calls, the old
   * token must NOT validate — otherwise an edited body could be sent
   * without fresh user approval. Frontmatter-only hashing missed
   * this; content-hash (frontmatter + body) closes it.
   */
  it('invalidates the confirmation token when the draft body changes between calls', async () => {
    const originalDraft = '---\ndraft_id: d1\ntarget: slack:C123\n---\nOriginal body\n';
    const editedDraft = '---\ndraft_id: d1\ntarget: slack:C123\n---\nMALICIOUSLY EDITED BODY\n';

    let draftContent = originalDraft;
    const tool = createPrepareSendTool({
      now: () => FIXED_NOW,
      readFileImpl: async () => draftContent,
    });

    const first = await tool.handler({
      input: PrepareSendArgs.parse({ draft_path: '/tmp/d.md' }),
      ctx: { db: dbHandle.db },
    });
    expect(first.isOk()).toBe(true);
    if (!first.isOk()) return;
    const firstParsed = PrepareSendResult.parse(first.value);

    // Body mutates between the two prepare_send calls.
    draftContent = editedDraft;

    const second = await tool.handler({
      input: PrepareSendArgs.parse({
        draft_path: '/tmp/d.md',
        confirmed: true,
        confirmation_token: firstParsed.confirmation_token,
      }),
      ctx: { db: dbHandle.db },
    });
    expect(second.isErr()).toBe(true);
    if (second.isErr()) expect(second.error.message).toContain('confirmation_token mismatch');
  });

  it('uses MCP routing (not gh api) for a GitHub PR target', async () => {
    const draft = '---\ndraft_id: d2\ntarget: github:acme/widgets/pulls/9\n---\nLGTM modulo lint.\n';
    const tool = createPrepareSendTool({ now: () => FIXED_NOW, readFileImpl: makeReader(draft) });
    const first = await tool.handler({
      input: PrepareSendArgs.parse({ draft_path: '/tmp/d.md' }),
      ctx: { db: dbHandle.db },
    });
    if (!first.isOk()) throw new Error('unexpected error');
    const firstParsed = PrepareSendResult.parse(first.value);
    expect(firstParsed.server).toBe('github');
    expect(firstParsed.tool_name).toBe('add_issue_comment');

    const second = await tool.handler({
      input: PrepareSendArgs.parse({
        draft_path: '/tmp/d.md',
        confirmed: true,
        confirmation_token: firstParsed.confirmation_token,
      }),
      ctx: { db: dbHandle.db },
    });
    if (!second.isOk()) throw new Error('unexpected error');
    const secondParsed = PrepareSendResult.parse(second.value);
    expect(secondParsed.tool_args).toEqual({
      owner: 'acme',
      repo: 'widgets',
      issue_number: 9,
      body: 'LGTM modulo lint.',
    });
  });

  it('errors when target frontmatter is missing', async () => {
    const draft = '---\ndraft_id: d1\n---\nbody\n';
    const tool = createPrepareSendTool({ now: () => FIXED_NOW, readFileImpl: makeReader(draft) });
    const result = await tool.handler({
      input: PrepareSendArgs.parse({ draft_path: '/tmp/d.md' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('missing the required');
  });

  it('errors when target syntax is unsupported', async () => {
    const draft = '---\ntarget: facebook:lol\n---\nbody\n';
    const tool = createPrepareSendTool({ now: () => FIXED_NOW, readFileImpl: makeReader(draft) });
    const result = await tool.handler({
      input: PrepareSendArgs.parse({ draft_path: '/tmp/d.md' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('does not match any supported shape');
  });

  it('errors when body is empty', async () => {
    const draft = '---\ntarget: slack:C1\n---\n\n';
    const tool = createPrepareSendTool({ now: () => FIXED_NOW, readFileImpl: makeReader(draft) });
    const result = await tool.handler({
      input: PrepareSendArgs.parse({ draft_path: '/tmp/d.md' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('empty body');
  });

  it("errors when the draft file can't be read", async () => {
    const tool = createPrepareSendTool({
      now: () => FIXED_NOW,
      readFileImpl: async () => {
        throw new Error('ENOENT: no such file');
      },
    });
    const result = await tool.handler({
      input: PrepareSendArgs.parse({ draft_path: '/missing.md' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('failed to read');
  });
});
