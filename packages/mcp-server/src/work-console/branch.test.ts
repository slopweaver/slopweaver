/**
 * Tests for `ensureWorkConsoleBranch`. The git side-effects are pumped
 * through a fake `GitRunner` so the test is hermetic — no real git
 * binary, no real filesystem.
 */

import { describe, expect, it } from 'vitest';
import { resolveWorkConsoleConfig } from './config.ts';
import { ensureWorkConsoleBranch, readCurrentBranch, type GitRunResult, type GitRunner } from './branch.ts';

type Recorded = { argv: ReadonlyArray<string>; cwd: string };

function makeRunner(responses: ReadonlyArray<GitRunResult>): {
  runner: GitRunner;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  let i = 0;
  const runner: GitRunner = async ({ argv, cwd }) => {
    calls.push({ argv, cwd });
    const next = responses[i] ?? { exitCode: 0, stdout: '', stderr: '' };
    i += 1;
    return next;
  };
  return { runner, calls };
}

const config = resolveWorkConsoleConfig({ cwd: '/tmp/repo', branch: 'ai-work-console' });

describe('ensureWorkConsoleBranch', () => {
  it('returns no_git_repo when rev-parse fails', async () => {
    const { runner } = makeRunner([{ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }]);
    const result = await ensureWorkConsoleBranch({ config, runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.action).toBe('no_git_repo');
      expect(result.value.branch).toBe('ai-work-console');
    }
  });

  it('returns already_on_branch when HEAD matches', async () => {
    const { runner } = makeRunner([
      { exitCode: 0, stdout: '/tmp/repo\n', stderr: '' },
      { exitCode: 0, stdout: 'ai-work-console\n', stderr: '' },
    ]);
    const result = await ensureWorkConsoleBranch({ config, runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.action).toBe('already_on_branch');
  });

  it("switches when the branch exists but isn't current", async () => {
    const { runner, calls } = makeRunner([
      { exitCode: 0, stdout: '/tmp/repo\n', stderr: '' }, // rev-parse --show-toplevel
      { exitCode: 0, stdout: 'main\n', stderr: '' }, // rev-parse --abbrev-ref HEAD
      { exitCode: 0, stdout: '', stderr: '' }, // status --porcelain (clean)
      { exitCode: 0, stdout: '', stderr: '' }, // show-ref --verify (exists)
      { exitCode: 0, stdout: '', stderr: '' }, // switch ai-work-console
    ]);
    const result = await ensureWorkConsoleBranch({ config, runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.action).toBe('switched');
    expect(calls.at(-1)?.argv).toEqual(['switch', 'ai-work-console']);
  });

  it("creates and switches when the branch doesn't exist yet", async () => {
    const { runner, calls } = makeRunner([
      { exitCode: 0, stdout: '/tmp/repo\n', stderr: '' },
      { exitCode: 0, stdout: 'main\n', stderr: '' },
      { exitCode: 0, stdout: '', stderr: '' },
      { exitCode: 1, stdout: '', stderr: '' }, // show-ref fails → branch missing
      { exitCode: 0, stdout: '', stderr: '' }, // switch -c
    ]);
    const result = await ensureWorkConsoleBranch({ config, runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) expect(result.value.action).toBe('created_and_switched');
    expect(calls.at(-1)?.argv).toEqual(['switch', '-c', 'ai-work-console']);
  });

  it('refuses a dirty switch by default', async () => {
    const { runner } = makeRunner([
      { exitCode: 0, stdout: '/tmp/repo\n', stderr: '' },
      { exitCode: 0, stdout: 'main\n', stderr: '' },
      { exitCode: 0, stdout: ' M src/foo.ts\n', stderr: '' }, // dirty
    ]);
    const result = await ensureWorkConsoleBranch({ config, runner });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('WORK_CONSOLE_DIRTY_WORKTREE');
  });

  it('stashes when allowSwitchWithUncommitted is true', async () => {
    const { runner, calls } = makeRunner([
      { exitCode: 0, stdout: '/tmp/repo\n', stderr: '' },
      { exitCode: 0, stdout: 'main\n', stderr: '' },
      { exitCode: 0, stdout: ' M src/foo.ts\n', stderr: '' }, // dirty
      { exitCode: 0, stdout: 'Saved working directory\n', stderr: '' }, // stash push
      { exitCode: 0, stdout: '', stderr: '' }, // show-ref
      { exitCode: 0, stdout: '', stderr: '' }, // switch
    ]);
    const result = await ensureWorkConsoleBranch({ config, runner, allowSwitchWithUncommitted: true });
    expect(result.isOk()).toBe(true);
    expect(calls[3]?.argv[0]).toBe('stash');
  });
});

describe('readCurrentBranch', () => {
  it('returns both nulls when not a git repo', async () => {
    const { runner } = makeRunner([{ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }]);
    const result = await readCurrentBranch({ config, runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.branch).toBe(null);
      expect(result.value.repoRoot).toBe(null);
    }
  });

  it('returns the current branch name', async () => {
    const { runner } = makeRunner([
      { exitCode: 0, stdout: '/tmp/repo\n', stderr: '' },
      { exitCode: 0, stdout: 'main\n', stderr: '' },
    ]);
    const result = await readCurrentBranch({ config, runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.branch).toBe('main');
      expect(result.value.repoRoot).toBe('/tmp/repo');
    }
  });
});
