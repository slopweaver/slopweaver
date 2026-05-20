/**
 * Tests for the `bootstrap_work_console` MCP tool. The bootstrap module
 * itself is tested in `work-console/bootstrap.test.ts` with injected fake
 * Writers; this test exercises the tool's wire-shape contract using a
 * real temp dir + fake `GitRunner` so the tool's defaults all fire.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BootstrapWorkConsoleArgs, BootstrapWorkConsoleResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import type { GitRunResult, GitRunner } from '../../work-console/branch.ts';
import { createBootstrapWorkConsoleTool } from './bootstrap-work-console.ts';

function fakeRunner(responses: ReadonlyArray<GitRunResult>): GitRunner {
  let i = 0;
  return async () => {
    const r = responses[i] ?? { exitCode: 0, stdout: '', stderr: '' };
    i += 1;
    return r;
  };
}

describe('createBootstrapWorkConsoleTool', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let tempCwd: string;
  let config: WorkConsoleConfig;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempCwd = mkdtempSync(join(tmpdir(), 'slop-tool-boot-'));
    config = resolveWorkConsoleConfig({ cwd: tempCwd, branch: 'ai-work-console' });
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(tempCwd, { recursive: true, force: true });
  });

  it('scaffolds the whole console on first run and reports the populated result', async () => {
    const runner = fakeRunner([
      { exitCode: 128, stdout: '', stderr: 'fatal: not a git repository' }, // pretend no git so the test stays hermetic
    ]);
    const tool = createBootstrapWorkConsoleTool({ config, gitRunner: runner });
    const result = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = BootstrapWorkConsoleResult.parse(result.value);
      expect(parsed.branch).toBe('ai-work-console');
      expect(parsed.branch_action).toBe('no_git_repo');
      expect(parsed.console_dir).toBe(`${tempCwd}/.claude/personal`);
      expect(parsed.files_created.length).toBeGreaterThanOrEqual(8);
      expect(parsed.files_created).toContain('contexts/core-profile.md');
      expect(parsed.memory_file_created).toBe(true);
      expect(parsed.claude_md_import_added).toBe(true);
      expect(parsed.slash_commands_created.length).toBeGreaterThanOrEqual(11);
      expect(parsed.slash_commands_created).toContain('.claude/commands/session-start.md');
    }
    // Verify on-disk artifacts.
    expect(existsSync(`${tempCwd}/.claude/personal/contexts/core-profile.md`)).toBe(true);
    expect(existsSync(`${tempCwd}/.claude/SLOPWEAVER-MEMORY.md`)).toBe(true);
    expect(existsSync(`${tempCwd}/CLAUDE.md`)).toBe(true);
    expect(existsSync(`${tempCwd}/.claude/commands/session-start.md`)).toBe(true);
    const memory = readFileSync(`${tempCwd}/.claude/SLOPWEAVER-MEMORY.md`, 'utf-8');
    expect(memory).toContain('AI work console');
  });

  it('is idempotent on a re-run', async () => {
    const tool = createBootstrapWorkConsoleTool({
      config,
      gitRunner: fakeRunner([{ exitCode: 128, stdout: '', stderr: 'no git' }]),
    });
    const first = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(first.isOk()).toBe(true);

    const second = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(second.isOk()).toBe(true);
    if (second.isOk()) {
      const parsed = BootstrapWorkConsoleResult.parse(second.value);
      // Second run finds everything already present.
      expect(parsed.files_created).toEqual([]);
      expect(parsed.slash_commands_created).toEqual([]);
      expect(parsed.memory_file_created).toBe(false);
      expect(parsed.claude_md_import_added).toBe(false);
    }
  });

  it('honours an overridden branch name from the args', async () => {
    const runner = fakeRunner([{ exitCode: 128, stdout: '', stderr: 'no git' }]);
    const tool = createBootstrapWorkConsoleTool({ config, gitRunner: runner });
    const result = await tool.handler({
      input: BootstrapWorkConsoleArgs.parse({ branch: 'my-custom-console' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = BootstrapWorkConsoleResult.parse(result.value);
      expect(parsed.branch).toBe('my-custom-console');
    }
  });
});
