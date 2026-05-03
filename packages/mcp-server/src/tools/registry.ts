/**
 * Tool registry types.
 *
 * Authors call {@link defineTool} with strongly-typed Zod schemas (typically
 * imported from `@slopweaver/contracts`) and an async handler. The helper
 * returns a type-erased {@link Tool} so heterogeneous tools share a single
 * `ReadonlyArray<Tool>` storage type. Type erasure is sound because
 * `McpServer` validates input against `inputSchema` before invoking the
 * handler — the cast inside `defineTool` only affects compile time.
 */

import type { z } from 'zod';
import type { SlopweaverDatabase } from '@slopweaver/db';

/**
 * Per-call context handed to every tool handler. v1 only carries the Drizzle
 * database handle; later iterations will add an integration registry, an
 * evidence-log writer, etc.
 */
export type ToolHandlerContext = {
  db: SlopweaverDatabase;
};

export type ToolHandlerArgs<TInput> = {
  input: TInput;
  ctx: ToolHandlerContext;
};

export type ToolHandler<TInput, TOutput> = (args: ToolHandlerArgs<TInput>) => Promise<TOutput>;

/** Author-facing tool spec; `defineTool` converts this into a {@link Tool}. */
export type ToolDefinition<TInput, TOutput extends Record<string, unknown>> = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly outputSchema: z.ZodType<TOutput>;
  readonly handler: ToolHandler<TInput, TOutput>;
};

/**
 * Storage-level tool type. Generics are erased so `ReadonlyArray<Tool>` is
 * variance-safe. `outputSchema` keeps `Record<string, unknown>` because
 * MCP's `CallToolResult.structuredContent` is a JSON object.
 */
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly outputSchema: z.ZodType<Record<string, unknown>>;
  readonly handler: ToolHandler<unknown, Record<string, unknown>>;
};

export function defineTool<TInput, TOutput extends Record<string, unknown>>(
  definition: ToolDefinition<TInput, TOutput>,
): Tool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema as z.ZodType<unknown>,
    outputSchema: definition.outputSchema as z.ZodType<Record<string, unknown>>,
    handler: definition.handler as ToolHandler<unknown, Record<string, unknown>>,
  };
}
