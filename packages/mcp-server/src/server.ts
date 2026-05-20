/**
 * `createMcpServer` — wires the SlopWeaver tool + prompt registries onto an
 * MCP SDK `McpServer` and returns it directly. Advanced consumers can reach
 * the underlying low-level `Server` via the returned instance's `.server`
 * property.
 *
 * The function is transport-agnostic: callers attach a transport via
 * {@link startStdio} or by calling `.connect(transport)` on the returned
 * server themselves. The app layer owns lifecycle so that `createMcpServer`
 * can be exercised from in-memory tests without spawning a child process.
 *
 * Prompts are slash-commands-as-MCP-prompts. Each prompt builder returns a
 * `messages: PromptMessage[]` payload that the MCP client surfaces as a
 * slash command (`/mcp__slopweaver__session-start` by default, or just
 * `/session-start` if the user has also dropped a short-name slash-command
 * file into `.claude/commands/`).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { SlopweaverDatabase } from '@slopweaver/db';
import { McpErrors } from './errors.ts';
import type { McpPrompt } from './prompts/registry.ts';
import type { Tool } from './tools/registry.ts';

export type CreateMcpServerArgs = {
  db: SlopweaverDatabase;
  tools: ReadonlyArray<Tool>;
  /** Prompts surfaced via `prompts/list` and resolved via `prompts/get`. Optional — empty list is valid. */
  prompts?: ReadonlyArray<McpPrompt>;
  /** Server version string advertised to clients and reachable via the `ping` tool. */
  version: string;
};

const SERVER_NAME = 'slopweaver';

export function createMcpServer({ db, tools, prompts, version }: CreateMcpServerArgs): McpServer {
  const promptList = prompts ?? [];
  const capabilities: { tools: Record<string, unknown>; prompts?: Record<string, unknown> } = { tools: {} };
  if (promptList.length > 0) {
    capabilities.prompts = {};
  }
  const server = new McpServer({ name: SERVER_NAME, version }, { capabilities });

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
          // client sees a structured envelope. Sanitize: only `code` and
          // `message` cross the MCP boundary; `cause` (which may carry
          // HTTP response bodies, stack traces, or internal paths via
          // safeApiCall's wrap) stays server-side.
          const error = McpErrors.unexpected(tool.name, cause, cause instanceof Error ? cause.message : undefined);
          const clientError = { code: error.code, message: error.message };
          return {
            isError: true,
            structuredContent: clientError,
            content: [{ type: 'text', text: JSON.stringify(clientError) }],
          };
        }
        if (result.isErr()) {
          const clientError = { code: result.error.code, message: result.error.message };
          return {
            isError: true,
            structuredContent: clientError,
            content: [{ type: 'text', text: JSON.stringify(clientError) }],
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

  for (const prompt of promptList) {
    const config: { title?: string; description?: string; argsSchema?: Record<string, unknown> } = {
      description: prompt.description,
    };
    if (prompt.title !== undefined) {
      config.title = prompt.title;
    }
    if (prompt.argsSchema !== undefined) {
      config.argsSchema = prompt.argsSchema.shape;
    }
    server.registerPrompt(
      prompt.name,
      // The SDK's registerPrompt is generic over PromptArgsRawShape (a
      // ZodRawShape, not a ZodObject). The shape pluck above forwards the
      // raw shape correctly; the SDK reconstructs a parsed args object for
      // the callback. We cast through `as never` because the inferred
      // generic from our heterogeneous list-of-prompts storage erases the
      // schema's identity at the call site.
      config as never,
      async (args: Record<string, unknown>) => {
        let result: Awaited<ReturnType<typeof prompt.handler>>;
        try {
          result = await prompt.handler({ args, ctx: { db } });
        } catch (cause) {
          // Same boundary treatment as tools: wrap a thrown exception as a
          // single error-message user-text message so the client still sees
          // a coherent payload. MCP's `prompts/get` response has no
          // standard isError flag, so we encode the failure in the text.
          const error = McpErrors.promptUnexpected(
            prompt.name,
            cause,
            cause instanceof Error ? cause.message : undefined,
          );
          return {
            description: `Error: ${error.message}`,
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: `slopweaver prompt "${prompt.name}" failed: ${error.message}`,
                },
              },
            ],
          };
        }
        if (result.isErr()) {
          const error = result.error;
          return {
            description: `Error: ${error.message}`,
            messages: [
              {
                role: 'user' as const,
                content: {
                  type: 'text' as const,
                  text: `slopweaver prompt "${prompt.name}" failed: ${error.message}`,
                },
              },
            ],
          };
        }
        const { description, messages } = result.value;
        return {
          ...(description !== undefined && { description }),
          messages: messages.map((m) => ({
            role: m.role,
            content: { type: m.content.type, text: m.content.text },
          })),
        };
      },
    );
  }

  return server;
}
