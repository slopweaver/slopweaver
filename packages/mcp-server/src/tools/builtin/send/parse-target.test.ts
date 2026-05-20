import { describe, expect, it } from 'vitest';
import { parseTarget } from './parse-target.ts';

describe('parseTarget', () => {
  it('parses a Slack channel-only target', () => {
    expect(parseTarget('slack:C12345')).toEqual({ platform: 'slack', channel: 'C12345' });
  });

  it('parses a Slack channel + thread_ts target', () => {
    expect(parseTarget('slack:C12345/thread:1234.5678')).toEqual({
      platform: 'slack',
      channel: 'C12345',
      thread_ts: '1234.5678',
    });
  });

  it('parses a GitHub PR target', () => {
    expect(parseTarget('github:slopweaver/slopweaver/pull/123')).toEqual({
      platform: 'github',
      owner: 'slopweaver',
      repo: 'slopweaver',
      kind: 'pull',
      number: 123,
    });
  });

  it('parses a GitHub issue target', () => {
    expect(parseTarget('github:owner/repo/issue/7')).toEqual({
      platform: 'github',
      owner: 'owner',
      repo: 'repo',
      kind: 'issue',
      number: 7,
    });
  });

  it('parses a Gmail target', () => {
    expect(parseTarget('gmail:abc123')).toEqual({ platform: 'gmail', thread_id: 'abc123' });
  });

  it('parses a Linear target', () => {
    expect(parseTarget('linear:PLT-583')).toEqual({ platform: 'linear', issue_id: 'PLT-583' });
  });

  it('returns null for unknown platform prefix', () => {
    expect(parseTarget('jira:ABC-123')).toBeNull();
  });

  it('returns null for malformed GitHub target', () => {
    expect(parseTarget('github:owner/repo/notakind/1')).toBeNull();
    expect(parseTarget('github:owner/repo/pull/zero')).toBeNull();
  });

  it('returns null for slack with empty channel', () => {
    expect(parseTarget('slack:')).toBeNull();
    expect(parseTarget('slack:/thread:123')).toBeNull();
  });
});
