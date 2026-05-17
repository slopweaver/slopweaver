/**
 * Register `slopweaver` as an MCP server in a detected client's config.
 *
 * Strategy by client:
 *   - Claude Code: prefer `claude mcp add slopweaver -- npx -y @slopweaver/mcp-local`
 *     because that's the idiomatic path the README documents. If the `claude`
 *     binary is missing or the subprocess exits non-zero, fall back to a
 *     direct JSON merge against `~/.claude.json`.
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
import {
  access,
  mkdir as fsMkdir,
  readFile as fsReadFile,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
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

export type ExecImpl = (args: {
  command: string;
  args: string[];
  timeoutMs: number;
}) => Promise<ExecResult>;

export type ExecResult =
  | { kind: 'ok'; exitCode: number; stdout: string; stderr: string }
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
        resolve({ kind: 'spawn-error', cause: errno });
        return;
      }
      // Non-zero exit: errno.code is undefined here; node sets `killed` if
      // the timeout fired. Surface as a non-spawn error so the caller can
      // fall through to direct JSON write.
      resolve({ kind: 'ok', exitCode: 1, stdout, stderr });
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
 * Returns Ok on success, Err on a malformed existing config or filesystem failure.
 */
export function registerClient({
  kind,
  configPath,
  exec = DEFAULT_EXEC,
  fs = DEFAULT_FS,
}: RegisterClientArgs): ResultAsync<void, InitError> {
  if (kind === 'claude-code') {
    return tryClaudeMcpAdd({ exec }).andThen((added) =>
      added ? okAsync(undefined as void) : writeJsonConfig({ configPath, fs }),
    );
  }
  return writeJsonConfig({ configPath, fs });
}

function tryClaudeMcpAdd({ exec }: { exec: ExecImpl }): ResultAsync<boolean, InitError> {
  // `exec` is contract-bound to never reject — the DEFAULT_EXEC implementation
  // resolves spawn errors to `spawn-error` and non-zero exits to `exitCode > 0`.
  // `fromSafePromise` is correct here.
  return ResultAsync.fromSafePromise(
    exec({
      command: 'claude',
      args: ['mcp', 'add', 'slopweaver', '--', 'npx', '-y', '@slopweaver/mcp-local'],
      timeoutMs: CLAUDE_MCP_ADD_TIMEOUT_MS,
    }),
  ).andThen((result) => {
    if (result.kind === 'spawn-error') return okAsync(false);
    return okAsync(result.exitCode === 0);
  });
}

function writeJsonConfig({
  configPath,
  fs,
}: {
  configPath: string;
  fs: FsImpl;
}): ResultAsync<void, InitError> {
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
        promise: fs.writeFile(
          configPath,
          serializeConfig({ existing: parsed as Record<string, unknown> }),
        ),
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
  return ResultAsync.fromPromise(promise, (cause) =>
    InitErrors.fsError({ path, operation, cause }),
  );
}

function serializeConfig({ existing }: { existing: Record<string, unknown> }): string {
  const existingServers =
    typeof existing.mcpServers === 'object' && existing.mcpServers !== null
      ? (existing.mcpServers as Record<string, unknown>)
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
