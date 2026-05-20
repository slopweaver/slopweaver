/**
 * Smoke tests for every builtin prompt. We don't exhaustively pin the
 * body text — that would just make the tests churn whenever the prompt
 * is iterated on. Instead we assert structure: every prompt returns a
 * single user-role text message with non-empty content, and the args
 * the prompt declares actually flow through to the rendered text.
 */

import { describe, expect, it } from 'vitest';
import { okAsync } from '@slopweaver/errors';
import { allBuiltinPrompts } from './index.ts';

const fakeCtx = { db: {} as never };

describe('allBuiltinPrompts', () => {
  it('returns every SlopWeaver slash command in the expected order', () => {
    const names = allBuiltinPrompts().map((p) => p.name);
    expect(names).toEqual([
      'session-start',
      'fan-out-audit',
      'lock-in',
      'reconcile',
      'style-rule',
      'style-edit',
      'correct',
      'calibration-report',
      'recompile-profile',
      'decided',
      'focus',
    ]);
  });

  it('every prompt has a non-empty description and unique name', () => {
    const prompts = allBuiltinPrompts();
    const seen = new Set<string>();
    for (const p of prompts) {
      expect(p.description.length).toBeGreaterThan(0);
      expect(seen.has(p.name)).toBe(false);
      seen.add(p.name);
    }
  });

  it('every prompt builds a single user-text message', async () => {
    for (const prompt of allBuiltinPrompts()) {
      const result = await prompt.handler({ args: {}, ctx: fakeCtx });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.messages.length).toBe(1);
        const message = result.value.messages[0];
        expect(message?.role).toBe('user');
        expect(message?.content.type).toBe('text');
        expect((message?.content.text ?? '').length).toBeGreaterThan(100);
      }
    }
  });

  it('session-start surfaces the mode argument inline', async () => {
    const prompt = allBuiltinPrompts().find((p) => p.name === 'session-start');
    expect(prompt).toBeDefined();
    if (!prompt) return;
    const result = await prompt.handler({ args: { mode: 'bootstrap' }, ctx: fakeCtx });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages[0]?.content.text).toContain('bootstrap');
    }
  });

  it('style-rule surfaces the rule text verbatim', async () => {
    const prompt = allBuiltinPrompts().find((p) => p.name === 'style-rule');
    expect(prompt).toBeDefined();
    if (!prompt) return;
    const result = await prompt.handler({
      args: { rule: 'never use em-dashes; use a comma instead' },
      ctx: fakeCtx,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages[0]?.content.text).toContain('never use em-dashes');
    }
  });

  it('correct surfaces the correction text verbatim', async () => {
    const prompt = allBuiltinPrompts().find((p) => p.name === 'correct');
    expect(prompt).toBeDefined();
    if (!prompt) return;
    const result = await prompt.handler({
      args: { correction: 'stop section-headering every reply' },
      ctx: fakeCtx,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages[0]?.content.text).toContain('stop section-headering');
    }
  });

  it('decided surfaces the decision text verbatim', async () => {
    const prompt = allBuiltinPrompts().find((p) => p.name === 'decided');
    expect(prompt).toBeDefined();
    if (!prompt) return;
    const result = await prompt.handler({
      args: { decision: 'go with SQLite-backed reconciliation cache' },
      ctx: fakeCtx,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages[0]?.content.text).toContain('SQLite-backed reconciliation cache');
    }
  });

  it('focus surfaces the scope text verbatim and includes the duration', async () => {
    const prompt = allBuiltinPrompts().find((p) => p.name === 'focus');
    expect(prompt).toBeDefined();
    if (!prompt) return;
    const result = await prompt.handler({
      args: { scope: 'PR review only, ignore Slack', duration_minutes: 90 },
      ctx: fakeCtx,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages[0]?.content.text).toContain('PR review only, ignore Slack');
      expect(result.value.messages[0]?.content.text).toContain('90 minutes');
    }
  });

  it('calibration-report surfaces the since-cutoff arg', async () => {
    const prompt = allBuiltinPrompts().find((p) => p.name === 'calibration-report');
    expect(prompt).toBeDefined();
    if (!prompt) return;
    const result = await prompt.handler({
      args: { since: '2026-05-01T00:00:00Z' },
      ctx: fakeCtx,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages[0]?.content.text).toContain('2026-05-01T00:00:00Z');
    }
  });

  it('recompile-profile surfaces the trigger arg', async () => {
    const prompt = allBuiltinPrompts().find((p) => p.name === 'recompile-profile');
    expect(prompt).toBeDefined();
    if (!prompt) return;
    const result = await prompt.handler({
      args: { trigger: 'sprint boundary' },
      ctx: fakeCtx,
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.messages[0]?.content.text).toContain('sprint boundary');
    }
  });

  it('prompts marked with argsSchema expose their schema', () => {
    const prompts = allBuiltinPrompts();
    const session = prompts.find((p) => p.name === 'session-start');
    const fanOut = prompts.find((p) => p.name === 'fan-out-audit');
    expect(session?.argsSchema).toBeDefined();
    // fan-out-audit has no args; argsSchema should be undefined.
    expect(fanOut?.argsSchema).toBeUndefined();
  });

  it('prompt handlers are typed to return ResultAsync (not Promise<Result>)', async () => {
    // Sanity check on the type: okAsync(...) should be acceptable as a
    // handler return. The actual compile-time guard is the prompts'
    // own use of `okAsync` in their `handler:` bodies — this runtime
    // check just confirms ResultAsync is awaitable and resolves to a
    // Result with a working `.isOk()` method.
    const r = okAsync({ description: undefined, messages: [] });
    const awaited = await r;
    expect(awaited.isOk()).toBe(true);
  });
});
