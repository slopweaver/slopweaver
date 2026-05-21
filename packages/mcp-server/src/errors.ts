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

export interface SnapshotNameInvalidError extends BaseError {
  readonly code: 'MCP_SNAPSHOT_NAME_INVALID';
  readonly snapshotName: string;
  readonly reason: string;
}

export interface SnapshotExistsError extends BaseError {
  readonly code: 'MCP_SNAPSHOT_EXISTS';
  readonly snapshotPath: string;
}

export type McpToolError = McpToolUnexpectedError | SnapshotNameInvalidError | SnapshotExistsError;

export const McpErrors = {
  unexpected: (toolName: string, cause?: unknown, message?: string): McpToolUnexpectedError => ({
    code: 'MCP_TOOL_UNEXPECTED',
    message: message ?? `Unexpected error in tool "${toolName}"`,
    toolName,
    ...(cause !== undefined && { cause }),
  }),
  snapshotNameInvalid: ({
    snapshotName,
    reason,
  }: {
    snapshotName: string;
    reason: string;
  }): SnapshotNameInvalidError => ({
    code: 'MCP_SNAPSHOT_NAME_INVALID',
    message: `snapshot_name "${snapshotName}" is invalid: ${reason}`,
    snapshotName,
    reason,
  }),
  snapshotExists: ({ snapshotPath }: { snapshotPath: string }): SnapshotExistsError => ({
    code: 'MCP_SNAPSHOT_EXISTS',
    message: `snapshot already exists at ${snapshotPath}; pass overwrite: true to replace it`,
    snapshotPath,
  }),
} as const;
