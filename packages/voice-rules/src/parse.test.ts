/**
 * Pure-function tests for the rules-markdown parser. Each case
 * documents a real shape we expect users to write — the parser is the
 * forgiving layer between hand-edited markdown and a strict rule list.
 */

import { describe, expect, it } from 'vitest';
import { parseVoiceRules } from './parse.ts';

describe('parseVoiceRules', () => {
  it('returns an empty list for an empty doc', () => {
    const r = parseVoiceRules('');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toEqual([]);
  });

  it('parses a single forbid-token directive', () => {
    const r = parseVoiceRules(['# Rules', '', '- forbid: delve'].join('\n'));
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.length).toBe(1);
      const rule = r.value[0];
      expect(rule?.kind).toBe('forbid_token');
      if (rule?.kind === 'forbid_token') {
        expect(rule.token).toBe('delve');
        expect(rule.line).toBe(3);
      }
    }
  });

  it('parses a replace directive with => separator', () => {
    const r = parseVoiceRules('- replace: \\bnotably\\b => ');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const rule = r.value[0];
      expect(rule?.kind).toBe('replace');
      if (rule?.kind === 'replace') {
        expect(rule.pattern).toBe('\\bnotably\\b');
        expect(rule.replacement).toBe('');
      }
    }
  });

  it('parses a pattern directive', () => {
    const r = parseVoiceRules('- pattern: !+');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const rule = r.value[0];
      expect(rule?.kind).toBe('disallow_pattern');
      if (rule?.kind === 'disallow_pattern') {
        expect(rule.pattern).toBe('!+');
      }
    }
  });

  it('silently skips prose-style bullets (no directive prefix)', () => {
    const md = ['## Defaults', '', '- Honest hedges over false confidence.', '- forbid: very'].join('\n');
    const r = parseVoiceRules(md);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.length).toBe(1);
      expect(r.value[0]?.kind).toBe('forbid_token');
    }
  });

  it('treats sub-headings + indentation as transparent context', () => {
    const md = [
      '# Communication style',
      '',
      '## Hard rules',
      '',
      '- forbid: em-dash',
      '- forbid: very',
      '',
      '## Defaults',
      '',
      '- replace: !+ => .',
    ].join('\n');
    const r = parseVoiceRules(md);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.map((rule) => rule.kind)).toEqual(['forbid_token', 'forbid_token', 'replace']);
    }
  });

  it('returns an error on an unknown directive (typoed keyword)', () => {
    // A bullet that opens `<keyword>:` and doesn't match a known
    // directive is treated as a typoed directive, not prose — a silent
    // no-op here would let `- replcae: foo => bar` ship as a dead rule.
    const r = parseVoiceRules('- enforce: please');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('VOICE_RULES_PARSE_FAILED');
  });

  it('returns an error on a typoed directive keyword (replcae)', () => {
    const r = parseVoiceRules('- replcae: foo => bar');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('VOICE_RULES_PARSE_FAILED');
  });

  it('still allows plain prose bullets without a leading `<keyword>:` shape', () => {
    const md = [
      '## Defaults',
      '',
      '- Honest hedges over false confidence.',
      '- Plain prose with: a mid-sentence colon is fine.',
      '- forbid: very',
    ].join('\n');
    const r = parseVoiceRules(md);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.length).toBe(1);
      expect(r.value[0]?.kind).toBe('forbid_token');
    }
  });

  it('preserves the comma-space replacement verbatim', () => {
    const r = parseVoiceRules('- replace: -- => , ');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const rule = r.value[0];
      expect(rule?.kind).toBe('replace');
      if (rule?.kind === 'replace') {
        expect(rule.pattern).toBe('--');
        expect(rule.replacement).toBe(', ');
      }
    }
  });

  it('preserves a single-space-only replacement verbatim', () => {
    // Two spaces after `=>`: one consumes the delimiter, the second is
    // the replacement (collapse `--` to a single space).
    const r = parseVoiceRules('- replace: --  =>  ');
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      const rule = r.value[0];
      expect(rule?.kind).toBe('replace');
      if (rule?.kind === 'replace') {
        expect(rule.pattern).toBe('--');
        expect(rule.replacement).toBe(' ');
      }
    }
  });

  it('ignores directive bullets inside an Examples section', () => {
    const md = [
      '# Communication style',
      '',
      '## Hard rules',
      '',
      '- forbid: delve',
      '',
      '## Examples',
      '',
      '- forbid: NOT_A_REAL_RULE',
      "- replace: this should not fire => '",
      '',
      '## Notes',
      '',
      '- forbid: also-not-a-rule',
    ].join('\n');
    const r = parseVoiceRules(md);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) {
      expect(r.value.length).toBe(1);
      const rule = r.value[0];
      expect(rule?.kind).toBe('forbid_token');
      if (rule?.kind === 'forbid_token') {
        expect(rule.token).toBe('delve');
      }
    }
  });

  it('ignores typoed-directive bullets inside an Examples section', () => {
    // Regression check: the Examples-section gate must run *before* the
    // typoed-directive check, so a `- replcae: …` bullet quoted as an
    // illustration in Examples doesn't surface as a parse error.
    const md = ['## Examples', '', '- replcae: foo => bar'].join('\n');
    const r = parseVoiceRules(md);
    expect(r.isOk()).toBe(true);
    if (r.isOk()) expect(r.value).toEqual([]);
  });

  it('returns an error when a directive has an empty body', () => {
    const r = parseVoiceRules('- forbid: ');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('VOICE_RULES_PARSE_FAILED');
  });

  it('returns an error when a replace directive has no => separator', () => {
    const r = parseVoiceRules('- replace: notably');
    expect(r.isErr()).toBe(true);
    if (r.isErr()) expect(r.error.code).toBe('VOICE_RULES_PARSE_FAILED');
  });
});
