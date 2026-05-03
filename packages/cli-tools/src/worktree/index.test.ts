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

    expect(result).toEqual({ ok: true, worktreePath: '/wt/fix-issue-42' });
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

    expect(result).toEqual({ ok: true, worktreePath: '/wt/quick-fix' });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it('returns an error when sanitisation produces an empty slug', () => {
    const exec = vi.fn<ExecFn>(() => ({ status: 0 }) as ExecResult);

    const result = runWorktreeNew({
      rawName: '!!!',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/empty slug/);
      expect(result.exitCode).toBe(1);
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it('returns the failing exit code when git fetch fails', () => {
    const exec: ExecFn = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'fetch') return { status: 128 };
      return { status: 0 };
    };

    const result = runWorktreeNew({
      rawName: 'fix-x',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result).toEqual({ ok: false, error: 'git fetch origin main failed', exitCode: 128 });
  });

  it('returns the failing exit code when git worktree add fails', () => {
    const exec: ExecFn = (cmd, args) => {
      if (cmd === 'git' && args[0] === 'worktree') return { status: 128 };
      return { status: 0 };
    };

    const result = runWorktreeNew({
      rawName: 'fix-x',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result).toEqual({ ok: false, error: 'git worktree add failed', exitCode: 128 });
  });

  it('returns the failing exit code when pnpm install fails', () => {
    const exec: ExecFn = (cmd) => {
      if (cmd === 'pnpm') return { status: 1 };
      return { status: 0 };
    };

    const result = runWorktreeNew({
      rawName: 'fix-x',
      options: { install: true },
      deps: deps({ exec }),
    });

    expect(result).toEqual({ ok: false, error: 'pnpm install failed', exitCode: 1 });
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
