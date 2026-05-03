/**
 * Stdio transport wiring.
 *
 * v1 ships stdio-only (per decision #11): no HTTP, no auth. The app layer
 * (apps/mcp-local) calls `startStdio({ server })` after constructing the
 * server with `createMcpServer`. Lifecycle ownership stays with the app so
 * that signal handling, graceful shutdown, and process exit codes are not
 * baked into a shared package.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export type StartStdioArgs = {
  server: McpServer;
};

export type StartStdioHandle = {
  /** The stdio transport bound to the server. Exposed for tests and graceful shutdown. */
  transport: StdioServerTransport;
};

export async function startStdio({ server }: StartStdioArgs): Promise<StartStdioHandle> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return { transport };
}
