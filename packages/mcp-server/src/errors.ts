/**
 * MCP tool-domain error union and factories.
 *
 * Tools return `Result<TOutput, McpToolError>`. The server dispatcher in
 * `server.ts` `.match()`es and converts `Err` into an `isError: true`
 * structured response, so the MCP client sees a typed failure envelope
 * instead of a generic thrown-exception message.
 *
 * `McpToolError` is intentionally small for v1: most tool failures are
 * either an unexpected exception (`MCP_TOOL_UNEXPECTED`) or a domain
 * decision the tool itself encodes inside its `ok` output schema. We
 * expand the union as composite tools surface specific named failures.
 */

import type { BaseError } from '@slopweaver/errors';

export interface McpToolUnexpectedError extends BaseError {
  readonly code: 'MCP_TOOL_UNEXPECTED';
  readonly toolName: string;
  readonly cause?: unknown;
}

export type McpToolError = McpToolUnexpectedError;

export const McpErrors = {
  unexpected: (toolName: string, cause?: unknown, message?: string): McpToolUnexpectedError => ({
    code: 'MCP_TOOL_UNEXPECTED',
    message: message ?? `Unexpected error in tool "${toolName}"`,
    toolName,
    ...(cause !== undefined && { cause }),
  }),
} as const;
