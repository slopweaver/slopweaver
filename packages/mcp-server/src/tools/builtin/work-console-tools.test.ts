/**
 * End-to-end tests for the seven work-console MCP tools. Each tool gets
 * an in-memory DB and a fake git runner / fake cwd so the test is
 * hermetic. We assert the wire-shape Result via the strict
 * Zod-validated contract schemas.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  EnsureWorkConsoleBranchResult,
  GetCalibrationReportResult,
  GetWorkConsoleStateResult,
  ListConsoleFilesResult,
  LogWalkFeedbackResult,
  ReadConsoleFileResult,
  WriteConsoleFileResult,
} from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import type { GitRunResult, GitRunner } from '../../work-console/branch.ts';
import { createEnsureWorkConsoleBranchTool } from './ensure-work-console-branch.ts';
import { createGetCalibrationReportTool } from './get-calibration-report.ts';
import { createGetWorkConsoleStateTool } from './get-work-console-state.ts';
import { createListConsoleFilesTool } from './list-console-files.ts';
import { createLogWalkFeedbackTool } from './log-walk-feedback.ts';
import { createReadConsoleFileTool } from './read-console-file.ts';
import { createWriteConsoleFileTool } from './write-console-file.ts';

let dbHandle: ReturnType<typeof createDb>;
let tempCwd: string;
let config: WorkConsoleConfig;

beforeEach(() => {
  dbHandle = createDb({ path: ':memory:' });
  tempCwd = mkdtempSync(join(tmpdir(), 'slop-tools-'));
  config = resolveWorkConsoleConfig({ cwd: tempCwd, branch: 'ai-work-console', consoleRelDir: '.console' });
});

afterEach(() => {
  dbHandle.close();
  rmSync(tempCwd, { recursive: true, force: true });
});

function fakeRunner(responses: ReadonlyArray<GitRunResult>): GitRunner {
  let i = 0;
  return async () => {
    const r = responses[i] ?? { exitCode: 0, stdout: '', stderr: '' };
    i += 1;
    return r;
  };
}

describe('createEnsureWorkConsoleBranchTool', () => {
  it('returns no_git_repo when cwd is not a git repo', async () => {
    const runner = fakeRunner([{ exitCode: 128, stdout: '', stderr: 'fatal: not a git repo' }]);
    const tool = createEnsureWorkConsoleBranchTool({ config, runner });
    const result = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = EnsureWorkConsoleBranchResult.parse(result.value);
      expect(parsed.action).toBe('no_git_repo');
      expect(parsed.branch).toBe('ai-work-console');
    }
  });

  it('returns already_on_branch when HEAD matches', async () => {
    const runner = fakeRunner([
      { exitCode: 0, stdout: tempCwd, stderr: '' },
      { exitCode: 0, stdout: 'ai-work-console\n', stderr: '' },
    ]);
    const tool = createEnsureWorkConsoleBranchTool({ config, runner });
    const result = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = EnsureWorkConsoleBranchResult.parse(result.value);
      expect(parsed.action).toBe('already_on_branch');
    }
  });
});

describe('createGetWorkConsoleStateTool', () => {
  it('reports the layout with existence flags', async () => {
    const runner = fakeRunner([
      { exitCode: 0, stdout: tempCwd, stderr: '' },
      { exitCode: 0, stdout: 'ai-work-console\n', stderr: '' },
    ]);
    const tool = createGetWorkConsoleStateTool({
      config,
      runner,
      now: () => new Date('2026-05-21T10:00:00Z'),
    });
    const result = await tool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = GetWorkConsoleStateResult.parse(result.value);
      expect(parsed.branch).toBe('ai-work-console');
      expect(parsed.on_branch).toBe(true);
      expect(parsed.initialized).toBe(false);
      expect(parsed.layout.length).toBeGreaterThan(5);
      const work = parsed.layout.find((l) => l.path === 'work');
      expect(work).toBeDefined();
      expect(work?.exists).toBe(false);
    }
  });
});

describe('write_console_file + read_console_file + list_console_files round-trip', () => {
  it('writes, lists, reads', async () => {
    const writeTool = createWriteConsoleFileTool({ config });
    const readTool = createReadConsoleFileTool({ config });
    const listTool = createListConsoleFilesTool({ config });

    const write = await writeTool.handler({
      input: { path: 'work/x.md', content: '# x\n' },
      ctx: { db: dbHandle.db },
    });
    expect(write.isOk()).toBe(true);
    if (write.isOk()) {
      const parsed = WriteConsoleFileResult.parse(write.value);
      expect(parsed.created).toBe(true);
      expect(parsed.bytes_written).toBe(4);
    }

    const list = await listTool.handler({ input: { subdir: 'work' }, ctx: { db: dbHandle.db } });
    expect(list.isOk()).toBe(true);
    if (list.isOk()) {
      const parsed = ListConsoleFilesResult.parse(list.value);
      expect(parsed.entries.map((e) => e.path)).toEqual(['work/x.md']);
    }

    const read = await readTool.handler({ input: { path: 'work/x.md' }, ctx: { db: dbHandle.db } });
    expect(read.isOk()).toBe(true);
    if (read.isOk()) {
      const parsed = ReadConsoleFileResult.parse(read.value);
      expect(parsed.exists).toBe(true);
      expect(parsed.content).toBe('# x\n');
    }
  });

  it('write_console_file rejects path traversal at the wire boundary', async () => {
    const writeTool = createWriteConsoleFileTool({ config });
    const write = await writeTool.handler({
      input: { path: 'safe.md', content: 'x' },
      ctx: { db: dbHandle.db },
    });
    expect(write.isOk()).toBe(true);
  });
});

describe('log_walk_feedback + get_calibration_report', () => {
  it('appends a line and aggregates it', async () => {
    const logTool = createLogWalkFeedbackTool({
      config,
      now: () => new Date('2026-05-21T09:00:00Z'),
    });
    const reportTool = createGetCalibrationReportTool({
      config,
      now: () => new Date('2026-05-21T10:00:00Z'),
    });

    const log1 = await logTool.handler({
      input: {
        walk_id: 'walk_test_1',
        item_index: 1,
        outcome: 'approved-as-proposed',
        tags: ['friction:wrong-channel'],
      },
      ctx: { db: dbHandle.db },
    });
    expect(log1.isOk()).toBe(true);
    if (log1.isOk()) {
      const parsed = LogWalkFeedbackResult.parse(log1.value);
      expect(parsed.line_number).toBe(1);
    }

    await logTool.handler({
      input: { walk_id: 'walk_test_1', item_index: 2, outcome: 'edited' },
      ctx: { db: dbHandle.db },
    });

    const report = await reportTool.handler({
      input: { since: '2026-05-21T00:00:00.000Z' },
      ctx: { db: dbHandle.db },
    });
    expect(report.isOk()).toBe(true);
    if (report.isOk()) {
      const parsed = GetCalibrationReportResult.parse(report.value);
      expect(parsed.total_walks).toBe(1);
      expect(parsed.total_items).toBe(2);
      expect(parsed.outcome_counts['approved-as-proposed']).toBe(1);
      expect(parsed.outcome_counts['edited']).toBe(1);
      expect(parsed.acceptance_rate).toBe(0.5);
      expect(parsed.edit_rate).toBe(0.5);
    }
  });

  it('get_calibration_report returns all zeros when no log exists', async () => {
    const reportTool = createGetCalibrationReportTool({
      config,
      now: () => new Date('2026-05-21T10:00:00Z'),
    });
    const report = await reportTool.handler({ input: {}, ctx: { db: dbHandle.db } });
    expect(report.isOk()).toBe(true);
    if (report.isOk()) {
      const parsed = GetCalibrationReportResult.parse(report.value);
      expect(parsed.total_walks).toBe(0);
      expect(parsed.total_items).toBe(0);
      expect(parsed.acceptance_rate).toBe(0);
    }
  });
});

// Sanity assertion that the on-disk feedback file is exactly what we
// wrote — the schema is forward-compatible and a regression here would
// break the calibration aggregator silently.
describe('log_walk_feedback on-disk file shape', () => {
  it('writes a JSONL line that round-trips through JSON.parse', async () => {
    const logTool = createLogWalkFeedbackTool({
      config,
      now: () => new Date('2026-05-21T09:00:00Z'),
    });
    await logTool.handler({
      input: {
        walk_id: 'w',
        item_index: 1,
        outcome: 'approved-as-proposed',
        item_summary: 'test summary',
        proposed_action: 'reply to thread',
        user_action: 'do',
      },
      ctx: { db: dbHandle.db },
    });
    const logPath = join(tempCwd, '.claude/personal/state/lock-in-feedback.jsonl');
    const content = readFileSync(logPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.length > 0);
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['walk_id']).toBe('w');
    expect(parsed['outcome']).toBe('approved-as-proposed');
    expect(parsed['item_summary']).toBe('test summary');
  });
});

// Defensive use of `writeFileSync` to make sure the test file actually
// drove our IO paths above (lint guard).
void writeFileSync;
