import { describe, expect, it, vi } from 'vitest';
import { type ExecFn, type ExecResult, runWorktreeNew, type RunWorktreeNewDeps } from './index.ts';

const FAKE_ROOTS = { repoRoot: '/repo', worktreesRoot: '/wt' };

const okExec: ExecFn = () => ({ status: 0 });

function deps({
  exec = okExec,
  log = vi.fn(),
  resolveRoots = () => FAKE_ROOTS,
}: Partial<RunWorktreeNewDeps> = {}): RunWorktreeNewDeps {
  return { exec, log, resolveRoots };
}

describe('runWorktreeNew', () => {
  it('runs git fetch, git worktree add, and pnpm install in order', () => {
    const calls: { cmd: string; args: string[]; cwd: string }[] = [];
    const exec: ExecFn = (cmd, args, opts) => {
      calls.push({ cmd, args, cwd: opts.cwd });
      return { status: 0 };
    };

    const result = runWorktreeNew({
      rawName: 'fix-issue-42',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ worktreePath: '/wt/fix-issue-42' });
    }
    expect(calls).toEqual([
      { cmd: 'git', args: ['fetch', 'origin', 'main'], cwd: '/repo' },
      {
        cmd: 'git',
        args: ['worktree', 'add', '-b', 'worktree/fix-issue-42', '/wt/fix-issue-42', 'origin/main'],
        cwd: '/repo',
      },
      { cmd: 'pnpm', args: ['install'], cwd: '/wt/fix-issue-42' },
    ]);
  });

  it('skips pnpm install when options.install is false', () => {
    const exec = vi.fn<ExecFn>(() => ({ status: 0 }) as ExecResult);

    const result = runWorktreeNew({
      rawName: 'quick-fix',
      options: { install: false },
      deps: deps({ exec }),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ worktreePath: '/wt/quick-fix' });
    }
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('returns err WORKTREE_INVALID_NAME when sanitisation produces an empty slug', () => {
    const exec = vi.fn<ExecFn>(() => ({ status: 0 }) as ExecResult);

    const result = runWorktreeNew({
      rawName: '!!!',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('WORKTREE_INVALID_NAME');
      expect(result.error.message).toMatch(/empty slug/);
      expect(result.error.exitCode).toBe(1);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns err WORKTREE_GIT_FETCH_FAILED with the failing exit code', () => {
    const exec: ExecFn = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'fetch') return { status: 128 };
      return { status: 0 };
    };

    const result = runWorktreeNew({
      rawName: 'fix-x',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('WORKTREE_GIT_FETCH_FAILED');
      expect(result.error.exitCode).toBe(128);
    }
  });

  it('returns err WORKTREE_GIT_ADD_FAILED with the failing exit code', () => {
    const exec: ExecFn = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree') return { status: 128 };
      return { status: 0 };
    };

    const result = runWorktreeNew({
      rawName: 'fix-x',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('WORKTREE_GIT_ADD_FAILED');
      expect(result.error.exitCode).toBe(128);
    }
  });

  it('returns err WORKTREE_PNPM_INSTALL_FAILED with the failing exit code', () => {
    const exec: ExecFn = (cmd) => {
      if (cmd === 'pnpm') return { status: 1 };
      return { status: 0 };
    };

    const result = runWorktreeNew({
      rawName: 'fix-x',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('WORKTREE_PNPM_INSTALL_FAILED');
      expect(result.error.exitCode).toBe(1);
    }
  });

  it('emits human-readable log lines via the injected log function', () => {
    const log = vi.fn();
    runWorktreeNew({
      rawName: 'fix-issue-42',
      options: { install: false },
      deps: deps({ log }),
    });
    const lines = log.mock.calls.map((c) => String(c[0])).join('\n');
    expect(lines).toContain('creating worktree: /wt/fix-issue-42');
    expect(lines).toContain('new branch:        worktree/fix-issue-42');
    expect(lines).toContain('worktree ready');
  });
});
