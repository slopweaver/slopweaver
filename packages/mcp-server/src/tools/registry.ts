/**
 * Tool registry types.
 *
 * Authors call {@link defineTool} with strongly-typed Zod object schemas
 * (typically imported from `@slopweaver/contracts`) and an async handler.
 * The helper returns a type-erased {@link Tool} so heterogeneous tools share
 * a single `ReadonlyArray<Tool>` storage type. Type erasure is sound because
 * `McpServer` validates input against `inputSchema` before invoking the
 * handler — the cast inside `defineTool` only affects compile time.
 *
 * Both schemas are constrained to `z.ZodObject`. The MCP wire protocol
 * publishes `inputSchema` / `outputSchema` as JSON-Schema objects via
 * `tools/list`; non-object Zod schemas (effects, transforms, unions) round-
 * trip as `{}` and break client discovery, so we reject them at the type
 * boundary.
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
export type ToolDefinition<TInputSchema extends z.ZodObject, TOutputSchema extends z.ZodObject> = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: TInputSchema;
  readonly outputSchema: TOutputSchema;
  readonly handler: ToolHandler<z.infer<TInputSchema>, z.infer<TOutputSchema>>;
};

/**
 * Storage-level tool type. Generics are erased so `ReadonlyArray<Tool>` is
 * variance-safe. Both schemas remain `z.ZodObject` so the protocol-level
 * invariant survives the erasure.
 */
export type Tool = {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject;
  readonly outputSchema: z.ZodObject;
  readonly handler: ToolHandler<unknown, Record<string, unknown>>;
};

export function defineTool<TInputSchema extends z.ZodObject, TOutputSchema extends z.ZodObject>(
  definition: ToolDefinition<TInputSchema, TOutputSchema>,
): Tool {
  return {
    name: definition.name,
    description: definition.description,
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    handler: definition.handler as ToolHandler<unknown, Record<string, unknown>>,
  };
}
