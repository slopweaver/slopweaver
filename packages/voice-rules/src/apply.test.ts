/**
 * Pure-function tests for the rules applier. Cases cover every Rule
 * kind plus the contract that the applier never throws even on garbage
 * regex.
 */

import { describe, expect, it } from 'vitest';
import { applyVoiceRules } from './apply.ts';
import type { Rule } from './types.ts';

describe('applyVoiceRules', () => {
  it('strips a forbid token (case-insensitive) and collapses spaces', () => {
    const rule: Rule = { kind: 'forbid_token', token: 'delve', line: 1 };
    const { rewritten, edits } = applyVoiceRules("Let's delve into the details", [rule]);
    expect(rewritten).toBe("Let's into the details");
    expect(edits.length).toBe(1);
    expect(edits[0]?.count).toBe(1);
  });

  it('strips multiple occurrences and reports the count', () => {
    const rule: Rule = { kind: 'forbid_token', token: '!', line: 1 };
    const { rewritten, edits } = applyVoiceRules('Hey! Check this out!', [rule]);
    expect(rewritten).toBe('Hey Check this out');
    expect(edits[0]?.count).toBe(2);
  });

  it('applies a replace rule (regex)', () => {
    const rule: Rule = { kind: 'replace', pattern: '\\bnotably\\b', replacement: '', line: 1 };
    const { rewritten, edits } = applyVoiceRules('Notably, the result was good. notably so.', [rule]);
    // \bnotably\b is case-sensitive by default; only the lowercase
    // occurrence matches. The capitalized "Notably" survives.
    expect(rewritten).toBe('Notably, the result was good. so.');
    expect(edits[0]?.count).toBe(1);
  });

  it('applies a disallow_pattern rule (strips matches)', () => {
    const rule: Rule = { kind: 'disallow_pattern', pattern: '!+', line: 1 };
    const { rewritten, edits } = applyVoiceRules('Wow!! Really??!', [rule]);
    expect(rewritten).toBe('Wow Really??');
    expect(edits[0]?.count).toBe(2);
  });

  it('skips a rule with invalid regex without throwing', () => {
    const rule: Rule = { kind: 'replace', pattern: '[unclosed', replacement: 'x', line: 7 };
    const { rewritten, edits } = applyVoiceRules('untouched', [rule]);
    expect(rewritten).toBe('untouched');
    expect(edits.length).toBe(1);
    expect(edits[0]?.count).toBe(0);
    expect(edits[0]?.description).toContain('invalid regex');
  });

  it('applies rules in source order; later rules see earlier output', () => {
    const rules: ReadonlyArray<Rule> = [
      { kind: 'replace', pattern: '--', replacement: ', ', line: 1 },
      { kind: 'forbid_token', token: 'absolutely', line: 2 },
    ];
    const { rewritten } = applyVoiceRules("I'm absolutely fine -- just tired.", rules);
    // First rule turns "--" into ", " — second rule strips "absolutely",
    // and the post-pass collapses the double space left behind.
    expect(rewritten).toBe("I'm fine , just tired.");
  });

  it('preserves newlines while collapsing inline double-spaces', () => {
    const rules: ReadonlyArray<Rule> = [{ kind: 'forbid_token', token: 'X', line: 1 }];
    const input = 'a X b\nc X d';
    const { rewritten } = applyVoiceRules(input, rules);
    expect(rewritten).toBe('a b\nc d');
  });

  it('returns an empty edits list when nothing matches', () => {
    const rules: ReadonlyArray<Rule> = [{ kind: 'forbid_token', token: 'xyzzy', line: 1 }];
    const { rewritten, edits } = applyVoiceRules('hello world', rules);
    expect(rewritten).toBe('hello world');
    expect(edits).toEqual([]);
  });
});
