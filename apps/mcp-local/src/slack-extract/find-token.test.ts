import { describe, expect, it } from 'vitest';
import { findXoxcInDump, findXoxcInValues } from './find-token.ts';

describe('findXoxcInValues', () => {
  it('returns null on an empty array', () => {
    expect(findXoxcInValues({ values: [] })).toBeNull();
  });

  it('returns null when no value contains a token', () => {
    expect(findXoxcInValues({ values: ['nothing here', 'still nothing', '{"x":1}'] })).toBeNull();
  });

  it('finds a bare token string', () => {
    expect(findXoxcInValues({ values: ['xoxc-1234567890-abc'] })).toBe('xoxc-1234567890-abc');
  });

  it('finds a token embedded inside a larger JSON-encoded blob', () => {
    const blob = JSON.stringify({ token: 'xoxc-1111-2222-3333-aaaaaaaaaa', other: 'noise' });
    expect(findXoxcInValues({ values: ['unrelated', blob] })).toBe('xoxc-1111-2222-3333-aaaaaaaaaa');
  });

  it('returns the first match when multiple values contain tokens', () => {
    expect(
      findXoxcInValues({
        values: ['xoxc-aaaaaaaa-1111', 'noise', 'xoxc-bbbbbbbb-2222'],
      }),
    ).toBe('xoxc-aaaaaaaa-1111');
  });

  it('does not match a bare `xoxc-` prefix with no payload', () => {
    // Defensive: the pattern requires at least one alphanumeric/dash
    // character after the prefix. Without that, a half-redacted log
    // line wouldn't be confused for a real token.
    expect(findXoxcInValues({ values: ['leaked: xoxc-'] })).toBeNull();
  });

  it('does not match xoxb/xoxp/xoxa (bot or user-app tokens)', () => {
    expect(findXoxcInValues({ values: ['xoxb-1234', 'xoxp-1234', 'xoxa-1234'] })).toBeNull();
  });

  it('stops the match at characters outside the documented grammar', () => {
    // The token grammar is alphanumerics + dashes. A space, quote, or
    // `}` terminates the match.
    expect(findXoxcInValues({ values: ['{"token":"xoxc-aaaa-1111"}'] })).toBe('xoxc-aaaa-1111');
  });

  it('handles unicode noise around a valid token', () => {
    expect(findXoxcInValues({ values: ['💥 xoxc-aaaa-1111 💥'] })).toBe('xoxc-aaaa-1111');
  });
});

describe('findXoxcInDump', () => {
  it('walks nested objects to find a token in a leaf string', () => {
    const dump = {
      localConfig_v2: JSON.stringify({ teams: { T1: { token: 'xoxc-aaaa-1111-bbbb-cccc' } } }),
      otherKey: 'noise',
    };
    expect(findXoxcInDump({ dump })).toBe('xoxc-aaaa-1111-bbbb-cccc');
  });

  it('walks arrays', () => {
    const dump = ['unrelated', ['nested', 'xoxc-2222-aaaa']];
    expect(findXoxcInDump({ dump })).toBe('xoxc-2222-aaaa');
  });

  it('returns null when no string in the structure matches', () => {
    expect(findXoxcInDump({ dump: { a: 1, b: ['c', { d: 'noise' }] } })).toBeNull();
  });

  it('returns null for non-object scalars without a token', () => {
    expect(findXoxcInDump({ dump: 42 })).toBeNull();
    expect(findXoxcInDump({ dump: null })).toBeNull();
    expect(findXoxcInDump({ dump: 'plain string' })).toBeNull();
  });

  it('matches a scalar string passed directly', () => {
    expect(findXoxcInDump({ dump: 'xoxc-3333-dddd' })).toBe('xoxc-3333-dddd');
  });
});
