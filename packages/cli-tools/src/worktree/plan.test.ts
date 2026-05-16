import { describe, expect, it } from 'vitest';
import { buildWorktreePlan, sanitiseTaskName } from './plan.ts';

describe('sanitiseTaskName', () => {
  it('lowercases and keeps hyphens, digits, underscores', () => {
    expect(sanitiseTaskName({ input: 'Fix-Issue_42' })).toBe('fix-issue_42');
  });

  it('replaces runs of disallowed characters with single hyphens', () => {
    expect(sanitiseTaskName({ input: 'fix the broken thing!!' })).toBe('fix-the-broken-thing');
  });

  it('trims leading and trailing hyphens', () => {
    expect(sanitiseTaskName({ input: '  --hello-world--  ' })).toBe('hello-world');
  });

  it('collapses repeated hyphens', () => {
    expect(sanitiseTaskName({ input: 'foo---bar' })).toBe('foo-bar');
  });

  it('returns empty string for input that has no allowed characters', () => {
    expect(sanitiseTaskName({ input: '!!!' })).toBe('');
  });

  it('handles unicode by replacing it with hyphens', () => {
    expect(sanitiseTaskName({ input: 'café-naïve' })).toBe('caf-na-ve');
  });
});

describe('buildWorktreePlan', () => {
  it('returns ok with the worktree path, branch name, and base ref', () => {
    const result = buildWorktreePlan({
      rawName: 'fix-issue-42',
      worktreesRoot: '/Users/me/dev/worktrees',
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        safeName: 'fix-issue-42',
        worktreePath: '/Users/me/dev/worktrees/fix-issue-42',
        branchName: 'worktree/fix-issue-42',
        baseRef: 'origin/main',
      });
    }
  });

  it('sanitises the raw name before building the path', () => {
    const result = buildWorktreePlan({
      rawName: 'Fix Issue 42!!',
      worktreesRoot: '/wt',
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({
        safeName: 'fix-issue-42',
        worktreePath: '/wt/fix-issue-42',
        branchName: 'worktree/fix-issue-42',
        baseRef: 'origin/main',
      });
    }
  });

  it('returns err WORKTREE_INVALID_NAME when the sanitised name is empty', () => {
    const result = buildWorktreePlan({ rawName: '!!!', worktreesRoot: '/wt' });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('WORKTREE_INVALID_NAME');
      expect(result.error.message).toMatch(/empty slug/);
    }
  });
});
