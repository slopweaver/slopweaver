import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findMonorepoRoot, resolveWorktreesRoot } from './paths.ts';

describe('findMonorepoRoot', () => {
  it('returns a directory that contains pnpm-workspace.yaml', () => {
    const root = findMonorepoRoot();
    expect(existsSync(join(root, 'pnpm-workspace.yaml'))).toBe(true);
  });
});

describe('resolveWorktreesRoot', () => {
  it('returns the sibling worktrees directory next to the repo', () => {
    expect(resolveWorktreesRoot({ repoRoot: '/Users/me/dev/slopweaver' })).toBe(
      '/Users/me/dev/worktrees',
    );
  });

  it('handles short paths', () => {
    expect(resolveWorktreesRoot({ repoRoot: '/a/b/c' })).toBe('/a/b/worktrees');
  });
});
