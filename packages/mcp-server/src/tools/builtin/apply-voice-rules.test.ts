/**
 * Smoke test for the apply_voice_rules MCP tool. The pure-function
 * core is fully tested in @slopweaver/voice-rules; this test just
 * confirms the wire-shape contract holds end-to-end.
 */

import { ApplyVoiceRulesArgs, ApplyVoiceRulesResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApplyVoiceRulesTool } from './apply-voice-rules.ts';

const FIXED_NOW = 1_762_000_000_000;

describe('createApplyVoiceRulesTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('rewrites the draft according to the parsed rules and returns the edit log', async () => {
    const tool = createApplyVoiceRulesTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: ApplyVoiceRulesArgs.parse({
        draft: "Let's delve into the details!",
        rules_markdown: ['# Rules', '', '- forbid: delve', '- pattern: !+'].join('\n'),
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = ApplyVoiceRulesResult.parse(result.value);
      expect(parsed.rewritten).toBe("Let's into the details");
      expect(parsed.edits.length).toBe(2);
      expect(parsed.edits[0]?.kind).toBe('forbid_token');
      expect(parsed.edits[0]?.count).toBe(1);
      expect(parsed.edits[1]?.kind).toBe('disallow_pattern');
      expect(parsed.edits[1]?.count).toBe(1);
      expect(parsed.generated_at).toBe(new Date(FIXED_NOW).toISOString());
    }
  });

  it('returns an empty edits list when no rules match', async () => {
    const tool = createApplyVoiceRulesTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: ApplyVoiceRulesArgs.parse({
        draft: 'Hello there.',
        rules_markdown: '- forbid: xyzzy',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = ApplyVoiceRulesResult.parse(result.value);
      expect(parsed.rewritten).toBe('Hello there.');
      expect(parsed.edits).toEqual([]);
    }
  });

  it('surfaces a parse error as a typed MCP error', async () => {
    const tool = createApplyVoiceRulesTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: ApplyVoiceRulesArgs.parse({
        draft: 'whatever',
        rules_markdown: '- replace: bad-no-arrow',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('MCP_TOOL_UNEXPECTED');
      expect(result.error.message).toContain('Could not parse');
    }
  });
});
