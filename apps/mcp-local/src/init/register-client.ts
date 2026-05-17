/**
 * Register `slopweaver` as an MCP server in a detected client's config.
 *
 * Strategy by client:
 *   - Claude Code: prefer `claude mcp add slopweaver -- npx -y @slopweaver/mcp-local`
 *     because that's the idiomatic path the README documents. Fall back to a
 *     direct JSON merge against `~/.claude.json` ONLY when `claude` isn't
 *     installed (ENOENT). If `claude mcp add` ran and exited non-zero (auth
 *     failure, validation, version skew, timeout), we surface the failure as
 *     `INIT_CLAUDE_MCP_ADD_FAILED` and refuse to overwrite `~/.claude.json`
 *     ourselves — silently doing so would mask the upstream failure and
 *     could corrupt the user's config.
 *   - Cursor & Cline: always read-modify-write JSON. No equivalent CLI.
 *
 * Read-modify-write semantics: if the file exists and is valid JSON, the
 * existing `mcpServers` map is preserved and `slopweaver` is added or
 * overwritten in place. Any other top-level keys (model, theme, project
 * paths, …) are passed through untouched. If the file exists but isn't
 * valid JSON, we return `INIT_MCP_CONFIG_MALFORMED` rather than overwrite —
 * the user's broken config is more recoverable than a clobbered one.
 *
 * All collaborators (`exec`, `fs`) are dependency-injected so tests can
 * substitute fakes without touching the real subprocess / filesystem.
 */

import { execFile } from 'node:child_process';
import { access, mkdir as fsMkdir, readFile as fsReadFile, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { errAsync, okAsync, ResultAsync } from '@slopweaver/errors';
import { type InitError, InitErrors } from './errors.ts';
import type { McpClientKind } from './detect-clients.ts';

export type RegisterClientArgs = {
  kind: McpClientKind;
  configPath: string;
  exec?: ExecImpl;
  fs?: FsImpl;
};

export type ExecImpl = (args: { command: string; args: string[]; timeoutMs: number }) => Promise<ExecResult>;

export type ExecResult =
  | { kind: 'ok'; exitCode: 0; stdout: string; stderr: string }
  | { kind: 'non-zero'; exitCode: number; stdout: string; stderr: string }
  | { kind: 'spawn-error'; cause: NodeJS.ErrnoException };

export type FsImpl = {
  mkdir: (path: string) => Promise<void>;
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, contents: string) => Promise<void>;
  fileExists: (path: string) => Promise<boolean>;
};

const SLOPWEAVER_ENTRY = {
  command: 'npx',
  args: ['-y', '@slopweaver/mcp-local'],
} as const;

const CLAUDE_MCP_ADD_TIMEOUT_MS = 10_000;

const DEFAULT_EXEC: ExecImpl = ({ command, args, timeoutMs }) =>
  new Promise((resolve) => {
    execFile(command, args, { timeout: timeoutMs, encoding: 'utf-8' }, (cause, stdout, stderr) => {
      if (cause === null) {
        resolve({ kind: 'ok', exitCode: 0, stdout, stderr });
        return;
      }
      const errno = cause as NodeJS.ErrnoException;
      if (typeof errno.code === 'string' && errno.code === 'ENOENT') {
        // The `claude` binary isn't on PATH at all. This is the one case
        // where falling through to a direct JSON write is safe: the user
        // doesn't have the official CLI to compete with us.
        resolve({ kind: 'spawn-error', cause: errno });
        return;
      }
      // Non-zero exit: errno.code is undefined for an actual non-zero exit;
      // node sets `killed` on the cause when the timeout fired. Either way,
      // `claude` ran and rejected — auth failure, validation, version skew,
      // timeout — and we must NOT silently overwrite ~/.claude.json on its
      // behalf. Surface the failure to the caller as a typed error.
      const exitCode = typeof errno.code === 'number' ? errno.code : 1;
      resolve({ kind: 'non-zero', exitCode, stdout, stderr });
    });
  });

const DEFAULT_FS: FsImpl = {
  mkdir: async (path) => {
    await fsMkdir(path, { recursive: true });
  },
  readFile: (path) => fsReadFile(path, 'utf-8'),
  writeFile: (path, contents) => fsWriteFile(path, contents, 'utf-8'),
  fileExists: async (path) => {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },
};

/**
 * Adds the `slopweaver` entry to the detected client's MCP config.
 * Returns Ok on success, Err on:
 *   - a malformed existing config (refusing to overwrite),
 *   - a filesystem failure, or
 *   - `claude mcp add` failing for a reason that isn't "binary not installed"
 *     (auth, validation, version skew, timeout).
 */
export function registerClient({
  kind,
  configPath,
  exec = DEFAULT_EXEC,
  fs = DEFAULT_FS,
}: RegisterClientArgs): ResultAsync<void, InitError> {
  if (kind === 'claude-code') {
    return tryClaudeMcpAdd({ exec }).andThen((outcome) =>
      outcome === 'registered' ? okAsync(undefined as void) : writeJsonConfig({ configPath, fs }),
    );
  }
  return writeJsonConfig({ configPath, fs });
}

type ClaudeMcpAddOutcome = 'registered' | 'fallback-write';

function tryClaudeMcpAdd({ exec }: { exec: ExecImpl }): ResultAsync<ClaudeMcpAddOutcome, InitError> {
  // `exec` is contract-bound to never reject — DEFAULT_EXEC resolves all three
  // branches as values (ok / non-zero / spawn-error). `fromSafePromise` is
  // correct here.
  return ResultAsync.fromSafePromise(
    exec({
      command: 'claude',
      args: ['mcp', 'add', 'slopweaver', '--', 'npx', '-y', '@slopweaver/mcp-local'],
      timeoutMs: CLAUDE_MCP_ADD_TIMEOUT_MS,
    }),
  ).andThen((result) => {
    if (result.kind === 'ok') return okAsync<ClaudeMcpAddOutcome, InitError>('registered');
    if (result.kind === 'spawn-error') {
      // ENOENT: `claude` isn't installed. Safe to fall back to direct write.
      return okAsync<ClaudeMcpAddOutcome, InitError>('fallback-write');
    }
    // Non-zero exit: `claude mcp add` ran and rejected. Surface as an error
    // so the wizard reports the failure to the user instead of silently
    // clobbering whatever ~/.claude.json says.
    return errAsync<ClaudeMcpAddOutcome, InitError>(
      InitErrors.claudeMcpAddFailed({ exitCode: result.exitCode, stderr: result.stderr }),
    );
  });
}

function writeJsonConfig({ configPath, fs }: { configPath: string; fs: FsImpl }): ResultAsync<void, InitError> {
  return fsCall({
    promise: fs.fileExists(configPath),
    path: configPath,
    operation: 'read',
  }).andThen((exists) => {
    if (!exists) {
      return fsCall({
        promise: fs.mkdir(dirname(configPath)),
        path: dirname(configPath),
        operation: 'mkdir',
      }).andThen(() =>
        fsCall({
          promise: fs.writeFile(configPath, serializeConfig({ existing: {} })),
          path: configPath,
          operation: 'write',
        }),
      );
    }

    return fsCall({
      promise: fs.readFile(configPath),
      path: configPath,
      operation: 'read',
    }).andThen((raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return errAsync(InitErrors.mcpConfigMalformed({ path: configPath }));
      }
      if (typeof parsed !== 'object' || parsed === null) {
        return errAsync(InitErrors.mcpConfigMalformed({ path: configPath }));
      }
      return fsCall({
        promise: fs.writeFile(configPath, serializeConfig({ existing: parsed as Record<string, unknown> })),
        path: configPath,
        operation: 'write',
      });
    });
  });
}

function fsCall<T>({
  promise,
  path,
  operation,
}: {
  promise: Promise<T>;
  path: string;
  operation: 'read' | 'write' | 'mkdir';
}): ResultAsync<T, InitError> {
  return ResultAsync.fromPromise(promise, (cause) => InitErrors.fsError({ path, operation, cause }));
}

function serializeConfig({ existing }: { existing: Record<string, unknown> }): string {
  const existingMcpServers = existing['mcpServers'];
  const existingServers =
    typeof existingMcpServers === 'object' && existingMcpServers !== null
      ? (existingMcpServers as Record<string, unknown>)
      : {};
  const merged: Record<string, unknown> = {
    ...existing,
    mcpServers: {
      ...existingServers,
      slopweaver: SLOPWEAVER_ENTRY,
    },
  };
  return `${JSON.stringify(merged, null, 2)}\n`;
}
