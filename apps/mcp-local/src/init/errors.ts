/**
 * Errors local to the init wizard.
 *
 * Two codes:
 *
 * - `INIT_TIMEOUT` — `withTimeout` fires when a wrapped operation does not
 *   resolve before the configured deadline. The original `ResultAsync` keeps
 *   running but its outcome is no longer observed.
 * - `INIT_MCP_CONFIG_MALFORMED` — an existing MCP client config (e.g.
 *   `~/.claude.json`) is on disk but is not valid JSON. We refuse to
 *   overwrite it because doing so would silently destroy whatever the user
 *   had — even if it was already broken — and offer a clearer recovery path
 *   than "I clobbered your config."
 *
 * Both extend `BaseError` so the dispatcher / CLI boundary prints them the
 * same way as every other domain error in the repo.
 */

import type { BaseError } from '@slopweaver/errors';

export interface InitTimeoutError extends BaseError {
  readonly code: 'INIT_TIMEOUT';
  readonly timeoutMs: number;
}

export interface InitMcpConfigMalformedError extends BaseError {
  readonly code: 'INIT_MCP_CONFIG_MALFORMED';
  readonly path: string;
}

export interface InitFsError extends BaseError {
  readonly code: 'INIT_FS_ERROR';
  readonly path: string;
  readonly operation: 'read' | 'write' | 'mkdir';
  readonly cause: unknown;
}

export interface InitClaudeMcpAddFailedError extends BaseError {
  readonly code: 'INIT_CLAUDE_MCP_ADD_FAILED';
  readonly exitCode: number;
  readonly stderr: string;
}

export type InitError = InitTimeoutError | InitMcpConfigMalformedError | InitFsError | InitClaudeMcpAddFailedError;

export const InitErrors = {
  timeout: ({ timeoutMs }: { timeoutMs: number }): InitTimeoutError => ({
    code: 'INIT_TIMEOUT',
    message: `Operation did not complete within ${timeoutMs}ms.`,
    timeoutMs,
  }),
  mcpConfigMalformed: ({ path }: { path: string }): InitMcpConfigMalformedError => ({
    code: 'INIT_MCP_CONFIG_MALFORMED',
    message: `Existing MCP config at ${path} is not valid JSON; refusing to overwrite. Fix the file by hand and re-run \`slopweaver init\`.`,
    path,
  }),
  fsError: ({
    path,
    operation,
    cause,
  }: {
    path: string;
    operation: InitFsError['operation'];
    cause: unknown;
  }): InitFsError => ({
    code: 'INIT_FS_ERROR',
    message: `Failed to ${operation} ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
    path,
    operation,
    cause,
  }),
  claudeMcpAddFailed: ({ exitCode, stderr }: { exitCode: number; stderr: string }): InitClaudeMcpAddFailedError => ({
    code: 'INIT_CLAUDE_MCP_ADD_FAILED',
    message: `\`claude mcp add slopweaver\` exited ${exitCode}: ${stderr.trim() || '(no stderr output)'}. Refusing to overwrite ~/.claude.json directly; resolve the upstream failure (auth, claude version, permissions) and re-run \`slopweaver init\`.`,
    exitCode,
    stderr,
  }),
} as const;
