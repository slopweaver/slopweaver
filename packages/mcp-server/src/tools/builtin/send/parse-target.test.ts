import { describe, expect, it } from 'vitest';
import { parseTarget } from './parse-target.ts';

describe('parseTarget', () => {
  it('parses a Slack channel-only target', () => {
    expect(parseTarget({ target: 'slack:C12345' })).toEqual({ platform: 'slack', channel: 'C12345' });
  });

  it('parses a Slack channel + thread_ts target', () => {
    expect(parseTarget({ target: 'slack:C12345/thread:1234.5678' })).toEqual({
      platform: 'slack',
      channel: 'C12345',
      thread_ts: '1234.5678',
    });
  });

  // Uses a fake owner/repo to keep the public repo free of self-references;
  // `parseTarget` is purely string-based and never resolves the owner/repo.
  it('parses a GitHub PR target (singular kind)', () => {
    expect(parseTarget({ target: 'github:acme/widgets/pull/123' })).toEqual({
      platform: 'github',
      owner: 'acme',
      repo: 'widgets',
      kind: 'pull',
      number: 123,
    });
  });

  // PR #71 emits `pulls/` (plural) in its template; accept both shapes and
  // normalise to the singular `pull` so downstream consumers see one form.
  it('parses a GitHub PR target with plural `pulls` kind and normalises to `pull`', () => {
    expect(parseTarget({ target: 'github:acme/widgets/pulls/456' })).toEqual({
      platform: 'github',
      owner: 'acme',
      repo: 'widgets',
      kind: 'pull',
      number: 456,
    });
  });

  it('parses a GitHub issue target (singular kind)', () => {
    expect(parseTarget({ target: 'github:owner/repo/issue/7' })).toEqual({
      platform: 'github',
      owner: 'owner',
      repo: 'repo',
      kind: 'issue',
      number: 7,
    });
  });

  it('parses a GitHub issue target with plural `issues` kind', () => {
    expect(parseTarget({ target: 'github:owner/repo/issues/7' })).toEqual({
      platform: 'github',
      owner: 'owner',
      repo: 'repo',
      kind: 'issue',
      number: 7,
    });
  });

  it('parses a Gmail target', () => {
    expect(parseTarget({ target: 'gmail:abc123' })).toEqual({ platform: 'gmail', thread_id: 'abc123' });
  });

  it('parses a Linear target', () => {
    expect(parseTarget({ target: 'linear:PLT-583' })).toEqual({ platform: 'linear', issue_id: 'PLT-583' });
  });

  it('returns null for unknown platform prefix', () => {
    expect(parseTarget({ target: 'jira:ABC-123' })).toBeNull();
  });

  it('returns null for malformed GitHub target', () => {
    expect(parseTarget({ target: 'github:owner/repo/notakind/1' })).toBeNull();
    expect(parseTarget({ target: 'github:owner/repo/pull/zero' })).toBeNull();
  });

  // Codex P2: the previous `Number.parseInt` happily returned 123 for
  // `123junk` — the tightened regex must reject any trailing garbage on the
  // numeric segment. Also reject leading zeros and negatives.
  it('returns null when the numeric segment has trailing garbage', () => {
    expect(parseTarget({ target: 'github:owner/repo/pull/123junk' })).toBeNull();
    expect(parseTarget({ target: 'github:owner/repo/pull/123 ' })).toBeNull();
  });

  it('returns null for a leading-zero numeric segment', () => {
    expect(parseTarget({ target: 'github:owner/repo/pull/0123' })).toBeNull();
  });

  it('returns null for a zero PR number', () => {
    expect(parseTarget({ target: 'github:owner/repo/pull/0' })).toBeNull();
  });

  it('returns null for slack with empty channel', () => {
    expect(parseTarget({ target: 'slack:' })).toBeNull();
    expect(parseTarget({ target: 'slack:/thread:123' })).toBeNull();
  });
});
