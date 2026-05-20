/**
 * `get_work_console_state` MCP tool.
 *
 * Diagnostic read tool that the `/session-start` prompt calls first to
 * decide whether the user is set up. Returns: configured branch, repo
 * root (or null if outside a repo), absolute console dir, whether we're
 * currently on the branch, whether the console dir exists, and a layout
 * map of expected sub-dirs with their existence flags.
 *
 * Layout is the ev-admin shape rendered generic:
 *   .claude/personal/contexts/    — durable identity / priorities
 *   .claude/personal/work/        — active work files
 *   .claude/personal/state/       — generated delta files + feedback log
 *   .claude/personal/rules/       — voice + style rules
 *   .claude/personal/daily/       — daily journals
 *   .claude/personal/drafts/      — message drafts
 *   .claude/personal/handoffs/    — handoff files for CMUX
 *   .claude/personal/HANDOVER-FOR-AI-AGENTS.md — top-level operating doc
 *
 * Each layout entry carries a one-liner `purpose` so an MCP client can
 * render a friendly diagnostic without re-querying.
 */

import { resolve } from 'node:path';
import { GetWorkConsoleStateArgs, GetWorkConsoleStateResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { readCurrentBranch, type GitRunner } from '../../work-console/branch.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { safeStat } from '../../work-console/files.ts';
import { consoleDir } from '../../work-console/paths.ts';
import { defineTool, type Tool } from '../registry.ts';

type LayoutEntry = {
  relPath: string;
  kind: 'dir' | 'file';
  purpose: string;
};

const LAYOUT: ReadonlyArray<LayoutEntry> = [
  { relPath: 'contexts', kind: 'dir', purpose: 'Durable identity, priorities, team directory.' },
  { relPath: 'work', kind: 'dir', purpose: 'Active work files (one per programme / workstream).' },
  { relPath: 'state', kind: 'dir', purpose: 'Generated delta files + walk-feedback JSONL.' },
  { relPath: 'rules', kind: 'dir', purpose: 'Voice + style + workflow rules.' },
  { relPath: 'daily', kind: 'dir', purpose: 'Daily journals (YYYY-MM/DD.md).' },
  { relPath: 'drafts', kind: 'dir', purpose: 'Drafted messages (file-first, never sent direct).' },
  { relPath: 'handoffs', kind: 'dir', purpose: 'Handoff prompts for parallel CMUX chats.' },
  { relPath: 'contexts/core-profile.md', kind: 'file', purpose: 'Always-loaded user fingerprint.' },
  { relPath: 'HANDOVER-FOR-AI-AGENTS.md', kind: 'file', purpose: 'Top-level operating doc for agents.' },
];

export type CreateGetWorkConsoleStateToolArgs = {
  config?: WorkConsoleConfig;
  runner?: GitRunner;
  now?: () => Date;
};

export function createGetWorkConsoleStateTool(args: CreateGetWorkConsoleStateToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();
  const runner = args.runner;
  const now = args.now ?? (() => new Date());

  return defineTool({
    name: 'get_work_console_state',
    description:
      'Reports the user’s current branch, repo root, console directory, and the existence of each expected console sub-path. Used by /session-start to decide whether to bootstrap.',
    inputSchema: GetWorkConsoleStateArgs,
    outputSchema: GetWorkConsoleStateResult,
    handler: async () => {
      const consoleAbs = consoleDir(config);
      const branchResult = await readCurrentBranch({ config, ...(runner !== undefined && { runner }) });
      if (branchResult.isErr()) {
        return err(McpErrors.unexpected('get_work_console_state', undefined, branchResult.error.message));
      }
      const currentBranch = branchResult.value.branch ?? '';
      const repoRoot = branchResult.value.repoRoot;
      const consoleDirStat = await safeStat(consoleAbs);
      if (consoleDirStat.isErr()) {
        return err(McpErrors.unexpected('get_work_console_state', undefined, consoleDirStat.error.message));
      }
      const layoutEntries: GetWorkConsoleStateResult['layout'] = [];
      for (const entry of LAYOUT) {
        const abs = resolve(consoleAbs, entry.relPath);
        const stat = await safeStat(abs);
        const exists = stat.isOk() ? stat.value.exists : false;
        layoutEntries.push({
          path: entry.relPath,
          exists,
          kind: entry.kind,
          purpose: entry.purpose,
        });
      }
      return ok({
        branch: config.branch,
        repo_root: repoRoot,
        console_dir: consoleAbs,
        on_branch: currentBranch === config.branch,
        initialized: consoleDirStat.value.exists,
        layout: layoutEntries,
        generated_at: now().toISOString(),
      });
    },
  });
}
