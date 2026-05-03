/**
 * `createMcpServer` — wires the SlopWeaver tool registry onto an MCP SDK
 * `McpServer` and returns it directly. Advanced consumers can reach the
 * underlying low-level `Server` via the returned instance's `.server`
 * property.
 *
 * The function is transport-agnostic: callers attach a transport via
 * {@link startStdio} or by calling `.connect(transport)` on the returned
 * server themselves. The app layer owns lifecycle so that `createMcpServer`
 * can be exercised from in-memory tests without spawning a child process.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlopweaverDatabase } from '@slopweaver/db';
import type { Tool } from './tools/registry.ts';

export type CreateMcpServerArgs = {
  db: SlopweaverDatabase;
  tools: ReadonlyArray<Tool>;
  /** Server version string advertised to clients and reachable via the `ping` tool. */
  version: string;
};

const SERVER_NAME = 'slopweaver';

export function createMcpServer({ db, tools, version }: CreateMcpServerArgs): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version }, { capabilities: { tools: {} } });

  for (const tool of tools) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      async (input: unknown) => {
        const output = await tool.handler({ input, ctx: { db } });
        return {
          structuredContent: output as Record<string, unknown>,
          content: [{ type: 'text', text: JSON.stringify(output) }],
        };
      },
    );
  }

  return server;
}
