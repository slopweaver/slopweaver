/**
 * @slopweaver/mcp-server public entry.
 *
 * Re-exports the framework-agnostic surface: the server factory, the tool
 * registry types, the builtin `ping` tool, and the stdio transport helper.
 * Apps wire these together; packages don't import from apps.
 */

export { createMcpServer } from './server.js';
export type { CreateMcpServerArgs } from './server.js';
export { defineTool } from './tools/registry.js';
export type {
  Tool,
  ToolDefinition,
  ToolHandler,
  ToolHandlerArgs,
  ToolHandlerContext,
} from './tools/registry.js';
export { createPingTool } from './tools/builtin/ping.js';
export type { CreatePingToolArgs } from './tools/builtin/ping.js';
export { startStdio } from './transports/stdio.js';
export type { StartStdioArgs, StartStdioHandle } from './transports/stdio.js';
