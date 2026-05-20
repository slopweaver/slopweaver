/**
 * Prompt registry — mirrors `tools/registry.ts` for MCP prompts.
 *
 * SlopWeaver ships its slash-command surface (`/session-start`, `/lock-in`,
 * `/reconcile`, `/style-rule`, `/style-edit`, `/correct`, `/fan-out-audit`)
 * as MCP prompts so a user gets the whole flow after `claude mcp add
 * slopweaver` with no further install, no env vars, no token paste. MCP
 * clients surface prompts as `/mcp__slopweaver__<name>`; consumers that
 * also drop short-name slash-command files into `.claude/commands/` get
 * the bare `/session-start` form too (handled by `slopweaver init`).
 *
 * Each prompt builds a `messages: PromptMessage[]` payload. Authors return
 * a pure-text user message by default — image/audio/resource content types
 * are supported by the SDK but unused here.
 */

import type { SlopweaverDatabase } from '@slopweaver/db';
import type { ResultAsync } from '@slopweaver/errors';
import type { z } from 'zod';
import type { McpPromptError } from '../errors.ts';

/** Per-call context handed to every prompt builder. Mirrors `ToolHandlerContext`. */
export type PromptHandlerContext = {
  db: SlopweaverDatabase;
};

/**
 * Minimal `PromptMessage` shape we emit. The SDK's union covers image /
 * audio / resource content too; SlopWeaver's prompts are pure text, so the
 * narrowed shape here keeps callers honest. If a future prompt needs a
 * different content type, broaden this — don't reach for `any`.
 */
export type SlopweaverPromptMessage = {
  role: 'user' | 'assistant';
  content: { type: 'text'; text: string };
};

export type PromptBuildResult = {
  description?: string;
  messages: ReadonlyArray<SlopweaverPromptMessage>;
};

export type PromptHandlerArgs<TArgs> = {
  args: TArgs;
  ctx: PromptHandlerContext;
};

export type PromptHandler<TArgs> = (args: PromptHandlerArgs<TArgs>) => ResultAsync<PromptBuildResult, McpPromptError>;

/**
 * Author-facing prompt spec. `argsSchema` is optional — most slash commands
 * take no arguments. When present, it must be a `z.ZodObject` so the SDK
 * can publish the JSON-Schema arg description to clients.
 */
export type PromptDefinition<TArgsSchema extends z.ZodObject | undefined> = {
  readonly name: string;
  readonly description: string;
  readonly title?: string;
  readonly argsSchema?: TArgsSchema;
  readonly handler: PromptHandler<TArgsSchema extends z.ZodObject ? z.infer<TArgsSchema> : Record<string, never>>;
};

/**
 * Storage-level prompt type. Type-erased so a single
 * `ReadonlyArray<McpPrompt>` can hold heterogeneous prompt definitions.
 * Erasure is sound because the SDK validates `argsSchema` before handing
 * args to the handler.
 */
export type McpPrompt = {
  readonly name: string;
  readonly description: string;
  readonly title?: string;
  readonly argsSchema?: z.ZodObject;
  readonly handler: PromptHandler<Record<string, unknown>>;
};

export function defineMcpPrompt<TArgsSchema extends z.ZodObject | undefined = undefined>(
  definition: PromptDefinition<TArgsSchema>,
): McpPrompt {
  const erased: McpPrompt = {
    name: definition.name,
    description: definition.description,
    handler: definition.handler as PromptHandler<Record<string, unknown>>,
  };
  if (definition.title !== undefined) {
    return {
      ...erased,
      title: definition.title,
      ...(definition.argsSchema ? { argsSchema: definition.argsSchema } : {}),
    };
  }
  return definition.argsSchema ? { ...erased, argsSchema: definition.argsSchema } : erased;
}
