/**
 * @slopweaver/mcp-server public entry.
 *
 * Re-exports the framework-agnostic surface: the server factory, the tool
 * registry types, the builtin `ping` tool, and the stdio transport helper.
 * Apps wire these together; packages don't import from apps.
 */

export { createMcpServer } from './server.ts';
export type { CreateMcpServerArgs } from './server.ts';
export { defineTool } from './tools/registry.ts';
export type {
  Tool,
  ToolDefinition,
  ToolHandler,
  ToolHandlerArgs,
  ToolHandlerContext,
} from './tools/registry.ts';
export { createPingTool } from './tools/builtin/ping.ts';
export type { CreatePingToolArgs } from './tools/builtin/ping.ts';
export { createCatchMeUpTool } from './tools/builtin/catch-me-up.ts';
export type { CreateCatchMeUpToolArgs } from './tools/builtin/catch-me-up.ts';
export { createGetFreshnessTool } from './tools/builtin/get-freshness.ts';
export type { CreateGetFreshnessToolArgs } from './tools/builtin/get-freshness.ts';
export { createSearchWorkContextTool } from './tools/builtin/search-work-context.ts';
export type { CreateSearchWorkContextToolArgs } from './tools/builtin/search-work-context.ts';
export { createStartSessionTool } from './tools/composite/start-session.ts';
export type {
  CreateStartSessionToolArgs,
  StartSessionPoller,
} from './tools/composite/start-session.ts';
export { startStdio } from './transports/stdio.ts';
export type { StartStdioArgs, StartStdioHandle } from './transports/stdio.ts';
export { defineMcpPrompt } from './prompts/registry.ts';
export type {
  McpPrompt,
  PromptBuildResult,
  PromptDefinition,
  PromptHandler,
  PromptHandlerArgs,
  PromptHandlerContext,
  SlopweaverPromptMessage,
} from './prompts/registry.ts';
export { allBuiltinPrompts } from './prompts/builtin/index.ts';
export { createSessionStartPrompt } from './prompts/builtin/session-start.ts';
export { createFanOutAuditPrompt } from './prompts/builtin/fan-out-audit.ts';
export { createLockInPrompt } from './prompts/builtin/lock-in.ts';
export { createReconcilePrompt } from './prompts/builtin/reconcile.ts';
export { createStyleRulePrompt } from './prompts/builtin/style-rule.ts';
export { createStyleEditPrompt } from './prompts/builtin/style-edit.ts';
export { createCorrectPrompt } from './prompts/builtin/correct.ts';
export { createEnsureWorkConsoleBranchTool } from './tools/builtin/ensure-work-console-branch.ts';
export type { CreateEnsureWorkConsoleBranchToolArgs } from './tools/builtin/ensure-work-console-branch.ts';
export { createGetWorkConsoleStateTool } from './tools/builtin/get-work-console-state.ts';
export type { CreateGetWorkConsoleStateToolArgs } from './tools/builtin/get-work-console-state.ts';
export { createReadConsoleFileTool } from './tools/builtin/read-console-file.ts';
export { createWriteConsoleFileTool } from './tools/builtin/write-console-file.ts';
export { createListConsoleFilesTool } from './tools/builtin/list-console-files.ts';
export { createLogWalkFeedbackTool } from './tools/builtin/log-walk-feedback.ts';
export { createGetCalibrationReportTool } from './tools/builtin/get-calibration-report.ts';
export type { WorkConsoleConfig } from './work-console/config.ts';
export {
  resolveWorkConsoleConfig,
  DEFAULT_WORK_CONSOLE_BRANCH,
  DEFAULT_CONSOLE_REL_DIR,
  DEFAULT_FEEDBACK_REL_PATH,
} from './work-console/config.ts';
export type { GitRunner, GitRunResult, EnsureBranchResult } from './work-console/branch.ts';
export { ensureWorkConsoleBranch, readCurrentBranch, defaultGitRunner } from './work-console/branch.ts';
export type { WorkConsoleError } from './work-console/errors.ts';
export { WorkConsoleErrors } from './work-console/errors.ts';
