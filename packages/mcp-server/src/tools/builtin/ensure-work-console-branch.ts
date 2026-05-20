/**
 * `ensure_work_console_branch` MCP tool.
 *
 * Switches the user's repo to the AI work-console branch (default
 * `ai-work-console`). This is the safety net that backs the
 * `/session-start` prompt: every prompt that mutates console files runs
 * this tool first to guarantee changes land on the right branch instead
 * of polluting a PR branch.
 *
 * Returns `action: 'no_git_repo'` when called outside a git repo so the
 * caller can decide whether to proceed anyway. Aborts with
 * `WORK_CONSOLE_DIRTY_WORKTREE` when the worktree has uncommitted changes
 * unless `allow_switch_with_uncommitted: true` is passed (in which case
 * the dirty state is stashed before the switch).
 */

import { EnsureWorkConsoleBranchArgs, EnsureWorkConsoleBranchResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { ensureWorkConsoleBranch, type GitRunner } from '../../work-console/branch.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateEnsureWorkConsoleBranchToolArgs = {
  /** Override the runtime config (cwd, branch name). Defaults to env-resolved. */
  config?: WorkConsoleConfig;
  /** Inject a fake git runner for tests. */
  runner?: GitRunner;
};

export function createEnsureWorkConsoleBranchTool(args: CreateEnsureWorkConsoleBranchToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();
  const runner = args.runner;

  return defineTool({
    name: 'ensure_work_console_branch',
    description:
      'Switches the current repo to the AI work-console branch (default `ai-work-console`). Creates the branch if missing. Returns action=no_git_repo when outside a git repo so the caller can decide whether to proceed.',
    inputSchema: EnsureWorkConsoleBranchArgs,
    outputSchema: EnsureWorkConsoleBranchResult,
    handler: async ({ input }) => {
      const result = await ensureWorkConsoleBranch({
        config,
        ...(runner !== undefined && { runner }),
        allowSwitchWithUncommitted: input.allow_switch_with_uncommitted ?? false,
      });
      if (result.isErr()) {
        // Branch errors come back as typed WorkConsoleError. The MCP boundary
        // only carries `code` + `message`, so callers see a clean envelope.
        return err(McpErrors.unexpected('ensure_work_console_branch', undefined, result.error.message));
      }
      const ensured = result.value;
      return ok({
        branch: ensured.branch,
        repo_root: ensured.repoRoot,
        action: ensured.action,
        ...(ensured.message !== undefined && { message: ensured.message }),
      });
    },
  });
}
