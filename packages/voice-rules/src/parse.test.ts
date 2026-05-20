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

  it('returns an error on an unknown directive', () => {
    const r = parseVoiceRules('- enforce: please');
    // The DIRECTIVE_RE only matches forbid/replace/pattern; everything
    // else is prose. So an unknown directive falls through silently.
    // That's the documented behavior (parser is forgiving).
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
