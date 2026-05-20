/**
 * `bootstrap_work_console` MCP tool. The "no-CLI install" entrypoint:
 * this is the tool that lets a user go from `claude mcp add slopweaver`
 * straight to `/session-start` with zero further setup. The session-start
 * prompt calls it whenever `get_work_console_state.initialized` is false.
 *
 * Wraps `runBootstrapWorkConsole` (the same routine `slopweaver init`
 * uses) with the default fs-based writers + the spawn-based git runner.
 * Idempotent — re-running with everything already in place returns
 * empty `files_created` / `slash_commands_created` lists and reports
 * `already_on_branch`.
 */

import { BootstrapWorkConsoleArgs, BootstrapWorkConsoleResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { defaultBootstrapWriters } from '../../work-console/bootstrap-runtime.ts';
import { runBootstrapWorkConsole } from '../../work-console/bootstrap.ts';
import { type GitRunner } from '../../work-console/branch.ts';
import { type WorkConsoleConfig } from '../../work-console/config.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateBootstrapWorkConsoleToolArgs = {
  /**
   * The runtime work-console config. The bootstrap reads `cwd` and
   * `branch` from this. Other fields are derived/defaulted by the
   * bootstrap module.
   */
  config?: WorkConsoleConfig;
  gitRunner?: GitRunner;
};

export function createBootstrapWorkConsoleTool(args: CreateBootstrapWorkConsoleToolArgs = {}): Tool {
  const writers = defaultBootstrapWriters();
  const gitRunner = args.gitRunner;

  return defineTool({
    name: 'bootstrap_work_console',
    description:
      'Idempotently scaffolds the AI work console: creates the ai-work-console branch if missing, drops the .claude/personal/ scaffold, writes SLOPWEAVER-MEMORY.md, adds the import to CLAUDE.md, drops .claude/commands/<name>.md shims for every builtin prompt. Safe to call from /session-start on every run.',
    inputSchema: BootstrapWorkConsoleArgs,
    outputSchema: BootstrapWorkConsoleResult,
    handler: async ({ input }) => {
      const cwd = args.config?.cwd ?? process.cwd();
      const branch = input.branch ?? args.config?.branch;
      const result = await runBootstrapWorkConsole({
        cwd,
        writers,
        ...(branch !== undefined && { branch }),
        ...(gitRunner !== undefined && { gitRunner }),
        allowSwitchWithUncommitted: input.allow_switch_with_uncommitted ?? false,
      });
      if (result.isErr()) {
        return err(McpErrors.unexpected('bootstrap_work_console', undefined, result.error.message));
      }
      const r = result.value;
      return ok({
        branch: r.branch,
        branch_action: r.branchAction,
        console_dir: r.consoleDir,
        files_created: [...r.filesCreated],
        memory_file_created: r.memoryFileCreated,
        claude_md_import_added: r.claudeMdImportAdded,
        slash_commands_created: [...r.slashCommandsCreated],
      });
    },
  });
}
