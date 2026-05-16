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
import { McpErrors } from './errors.ts';
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
        let result: Awaited<ReturnType<typeof tool.handler>>;
        try {
          result = await tool.handler({ input, ctx: { db } });
        } catch (cause) {
          // Handlers should return `Err` rather than throw, but a runaway
          // exception is still bound to the tool — wrap as isError so the
          // client sees a structured envelope.
          const error = McpErrors.unexpected(
            tool.name,
            cause,
            cause instanceof Error ? cause.message : undefined,
          );
          return {
            isError: true,
            structuredContent: { code: error.code, message: error.message },
            content: [{ type: 'text', text: JSON.stringify(error) }],
          };
        }
        if (result.isErr()) {
          return {
            isError: true,
            structuredContent: { code: result.error.code, message: result.error.message },
            content: [{ type: 'text', text: JSON.stringify(result.error) }],
          };
        }
        const output = result.value;
        return {
          structuredContent: output,
          content: [{ type: 'text', text: JSON.stringify(output) }],
        };
      },
    );
  }

  return server;
}
