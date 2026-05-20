/**
 * Tests for the work-console bootstrap step. Uses fake Writers and a
 * fake `GitRunner` so the test exercises every branch without touching
 * the real filesystem or invoking git.
 *
 * Verifies:
 *   - branch is created on first run, switched on subsequent runs
 *   - scaffold files are dropped only when missing
 *   - SLOPWEAVER-MEMORY.md gets the import line added to an existing
 *     CLAUDE.md (and creates CLAUDE.md if missing)
 *   - .claude/commands/<name>.md slash-command shims are dropped for
 *     every builtin prompt and skipped when the file already exists
 */

import { describe, expect, it } from 'vitest';
import type { GitRunner } from '@slopweaver/mcp-server';
import { runBootstrapWorkConsole } from './bootstrap-work-console.ts';

type WrittenFile = { content: string; created: boolean };

function makeWriters(seed: Map<string, string> = new Map()): {
  writers: Parameters<typeof runBootstrapWorkConsole>[0]['writers'];
  written: Map<string, WrittenFile>;
  store: Map<string, string>;
} {
  const store = new Map(seed);
  const written = new Map<string, WrittenFile>();
  return {
    store,
    written,
    writers: {
      fileExists: async (absPath) => store.has(absPath),
      readFile: async (absPath) => store.get(absPath) ?? null,
      writeFile: async (absPath, content) => {
        const created = !store.has(absPath);
        store.set(absPath, content);
        written.set(absPath, { content, created });
        return { bytesWritten: Buffer.byteLength(content, 'utf-8'), created };
      },
      mkdir: async () => {
        /* fake — no real dirs */
      },
    },
  };
}

function makeRunner(responses: ReadonlyArray<{ exitCode: number; stdout: string; stderr: string }>): GitRunner {
  let i = 0;
  return async () => {
    const r = responses[i] ?? { exitCode: 0, stdout: '', stderr: '' };
    i += 1;
    return r;
  };
}

describe('runBootstrapWorkConsole', () => {
  it('creates everything from scratch on first run', async () => {
    const { writers, store } = makeWriters();
    const runner = makeRunner([
      { exitCode: 0, stdout: '/tmp/repo\n', stderr: '' }, // rev-parse --show-toplevel
      { exitCode: 0, stdout: 'main\n', stderr: '' }, // current branch
      { exitCode: 0, stdout: '', stderr: '' }, // status (clean)
      { exitCode: 1, stdout: '', stderr: '' }, // show-ref (branch missing)
      { exitCode: 0, stdout: '', stderr: '' }, // switch -c
    ]);
    const result = await runBootstrapWorkConsole({ cwd: '/tmp/repo', writers, gitRunner: runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.branchAction).toBe('created_and_switched');
      expect(result.value.memoryFileCreated).toBe(true);
      expect(result.value.claudeMdImportAdded).toBe(true);
      // Slash-command shims are dropped one per builtin prompt.
      expect(result.value.slashCommandsCreated.length).toBeGreaterThanOrEqual(11);
      expect(result.value.slashCommandsCreated).toContain('.claude/commands/session-start.md');
      expect(result.value.slashCommandsCreated).toContain('.claude/commands/lock-in.md');
      expect(result.value.slashCommandsCreated).toContain('.claude/commands/focus.md');
      // Scaffold files are dropped.
      expect(result.value.filesCreated.length).toBeGreaterThanOrEqual(8);
      expect(result.value.filesCreated).toContain('contexts/core-profile.md');
    }
    // Spot-check on-disk content.
    expect(store.get('/tmp/repo/.claude/commands/session-start.md')).toContain('/session-start');
    expect(store.get('/tmp/repo/.claude/SLOPWEAVER-MEMORY.md')).toContain('AI work console');
    expect(store.get('/tmp/repo/CLAUDE.md')).toContain('@.claude/SLOPWEAVER-MEMORY.md');
  });

  it('skips files that already exist and reports an empty creation list for them', async () => {
    const seed = new Map<string, string>([
      ['/tmp/repo/.claude/personal/contexts/core-profile.md', '# existing — keep me'],
      ['/tmp/repo/.claude/commands/session-start.md', '---\ndescription: my custom shim\n---\n\nKeep this'],
      ['/tmp/repo/.claude/SLOPWEAVER-MEMORY.md', '# existing memory'],
      ['/tmp/repo/CLAUDE.md', '# existing memory\n@.claude/SLOPWEAVER-MEMORY.md\n'],
    ]);
    const { writers, store } = makeWriters(seed);
    const runner = makeRunner([
      { exitCode: 0, stdout: '/tmp/repo\n', stderr: '' },
      { exitCode: 0, stdout: 'ai-work-console\n', stderr: '' }, // already on branch
    ]);
    const result = await runBootstrapWorkConsole({ cwd: '/tmp/repo', writers, gitRunner: runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.branchAction).toBe('already_on_branch');
      expect(result.value.memoryFileCreated).toBe(false);
      expect(result.value.claudeMdImportAdded).toBe(false);
      // The session-start shim was already present; not re-listed.
      expect(result.value.slashCommandsCreated).not.toContain('.claude/commands/session-start.md');
      // But OTHER shims weren't present, so they ARE listed.
      expect(result.value.slashCommandsCreated).toContain('.claude/commands/lock-in.md');
      // The user's existing files are preserved.
      expect(store.get('/tmp/repo/.claude/personal/contexts/core-profile.md')).toContain('keep me');
      expect(store.get('/tmp/repo/.claude/commands/session-start.md')).toContain('my custom shim');
    }
  });

  it('reports no_git_repo when rev-parse fails and still scaffolds files', async () => {
    const { writers } = makeWriters();
    const runner = makeRunner([{ exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }]);
    const result = await runBootstrapWorkConsole({ cwd: '/tmp/repo', writers, gitRunner: runner });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.branchAction).toBe('no_git_repo');
      // Scaffold + memory + slash commands still happen — branch isolation
      // is just one of the three responsibilities.
      expect(result.value.filesCreated.length).toBeGreaterThan(0);
      expect(result.value.slashCommandsCreated.length).toBeGreaterThan(0);
    }
  });
});
