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

  it('returns the parsed Slack target + body + instructions', async () => {
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
      expect(parsed.instructions).toContain('5 seconds');
      expect(parsed.instructions).toContain('undo');
      expect(parsed.instructions).toContain('record_send_outcome');
    }
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
