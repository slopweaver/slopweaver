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
export { createRecallTool, createHashBagEmbedder, cosineSimilarity } from './tools/builtin/recall/index.ts';
export type { CreateRecallToolArgs, Embedder } from './tools/builtin/recall/index.ts';
export { createStartSessionTool } from './tools/composite/start-session.ts';
export type {
  CreateStartSessionToolArgs,
  StartSessionPoller,
} from './tools/composite/start-session.ts';
export { startStdio } from './transports/stdio.ts';
export type { StartStdioArgs, StartStdioHandle } from './transports/stdio.ts';
