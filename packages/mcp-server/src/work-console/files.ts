/**
 * Filesystem helpers for the work-console. Each function does an async I/O
 * step then returns a typed `Result<T, WorkConsoleError>`. Callers
 * (the MCP tools) await the ResultAsync wrapper produced by
 * `ResultAsync.fromSafePromise(...).andThen(passthrough)`.
 *
 * The inner async functions use try/catch — that's allowed by the
 * service-boundary scanner because they catch, classify, and return Err
 * rather than re-throwing. The wrapper ensures no path leaks an exception.
 */

import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile, appendFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { ResultAsync, type Result, err, errAsync, ok, okAsync } from '@slopweaver/errors';
import { type WorkConsoleConfig } from './config.ts';
import { type WorkConsoleError, WorkConsoleErrors } from './errors.ts';
import { resolveSafe } from './paths.ts';

const describeIo = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export type ReadFileOk = {
  exists: boolean;
  content: string | null;
  bytes: number | null;
  absolutePath: string;
};

async function safeReadImpl(config: WorkConsoleConfig, relPath: string): Promise<Result<ReadFileOk, WorkConsoleError>> {
  const resolved = resolveSafe(config, relPath);
  if (resolved.isErr()) return err(resolved.error);
  const absolutePath = resolved.value;
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) {
      return err(WorkConsoleErrors.io(absolutePath, 'read', 'not a regular file'));
    }
    const content = await readFile(absolutePath, 'utf-8');
    return ok({
      exists: true,
      content,
      bytes: Buffer.byteLength(content, 'utf-8'),
      absolutePath,
    });
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok({ exists: false, content: null, bytes: null, absolutePath });
    }
    return err(WorkConsoleErrors.io(absolutePath, 'read', describeIo(e)));
  }
}

export function safeReadConsoleFile(
  config: WorkConsoleConfig,
  relPath: string,
): ResultAsync<ReadFileOk, WorkConsoleError> {
  return wrapResultPromise(safeReadImpl(config, relPath));
}

export type WriteFileOk = {
  bytesWritten: number;
  created: boolean;
  absolutePath: string;
};

async function safeWriteImpl(
  config: WorkConsoleConfig,
  relPath: string,
  content: string,
  options: { createIfMissing?: boolean } = {},
): Promise<Result<WriteFileOk, WorkConsoleError>> {
  const createIfMissing = options.createIfMissing !== false;
  const resolved = resolveSafe(config, relPath);
  if (resolved.isErr()) return err(resolved.error);
  const absolutePath = resolved.value;
  const dir = dirname(absolutePath);
  let created = true;
  try {
    await stat(absolutePath);
    created = false;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      return err(WorkConsoleErrors.io(absolutePath, 'stat', describeIo(e)));
    }
  }
  if (created && !createIfMissing) {
    return err(WorkConsoleErrors.fileMissing(absolutePath));
  }
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    return err(WorkConsoleErrors.io(dir, 'mkdir', describeIo(e)));
  }
  const tmpPath = `${absolutePath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 10)}`;
  try {
    await writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o644 });
  } catch (e) {
    return err(WorkConsoleErrors.io(tmpPath, 'write', describeIo(e)));
  }
  try {
    await rename(tmpPath, absolutePath);
  } catch (e) {
    return err(WorkConsoleErrors.io(absolutePath, 'write', describeIo(e)));
  }
  return ok({
    bytesWritten: Buffer.byteLength(content, 'utf-8'),
    created,
    absolutePath,
  });
}

export function safeWriteConsoleFile(
  config: WorkConsoleConfig,
  relPath: string,
  content: string,
  options: { createIfMissing?: boolean } = {},
): ResultAsync<WriteFileOk, WorkConsoleError> {
  return wrapResultPromise(safeWriteImpl(config, relPath, content, options));
}

export type ConsoleEntry = {
  relPath: string;
  kind: 'file' | 'dir';
  bytes: number | null;
  modifiedAtIso: string | null;
};

async function listImpl(
  config: WorkConsoleConfig,
  subdir: string,
): Promise<Result<{ subdir: string; entries: ConsoleEntry[] }, WorkConsoleError>> {
  const resolvedDir = resolveSafe(config, subdir);
  if (resolvedDir.isErr()) return err(resolvedDir.error);
  const absDir = resolvedDir.value;
  const displaySubdir = subdir.length > 0 ? subdir : '.';
  let dirents: Dirent[];
  try {
    dirents = await readdir(absDir, { withFileTypes: true });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok({ subdir: displaySubdir, entries: [] });
    }
    return err(WorkConsoleErrors.io(absDir, 'list', describeIo(e)));
  }
  const sorted = [...dirents].sort((a, b) => a.name.localeCompare(b.name));
  const entries: ConsoleEntry[] = [];
  for (const dirent of sorted) {
    const relChildPath = subdir && subdir !== '.' ? `${subdir}/${dirent.name}` : dirent.name;
    const absChildPath = `${absDir}/${dirent.name}`;
    try {
      const info = await stat(absChildPath);
      entries.push({
        relPath: relChildPath,
        kind: dirent.isDirectory() ? 'dir' : 'file',
        bytes: dirent.isFile() ? info.size : null,
        modifiedAtIso: info.mtime.toISOString(),
      });
    } catch {
      entries.push({
        relPath: relChildPath,
        kind: dirent.isDirectory() ? 'dir' : 'file',
        bytes: null,
        modifiedAtIso: null,
      });
    }
  }
  return ok({ subdir: displaySubdir, entries });
}

export function listConsoleDir(
  config: WorkConsoleConfig,
  subdir: string,
): ResultAsync<{ subdir: string; entries: ConsoleEntry[] }, WorkConsoleError> {
  return wrapResultPromise(listImpl(config, subdir));
}

export type AppendJsonlOk = {
  bytesAppended: number;
  absolutePath: string;
};

async function appendJsonlImpl(absPath: string, line: string): Promise<Result<AppendJsonlOk, WorkConsoleError>> {
  const withNewline = line.endsWith('\n') ? line : `${line}\n`;
  const dir = dirname(absPath);
  try {
    await mkdir(dir, { recursive: true });
  } catch (e) {
    return err(WorkConsoleErrors.io(dir, 'mkdir', describeIo(e)));
  }
  try {
    await appendFile(absPath, withNewline, { encoding: 'utf-8', mode: 0o644 });
  } catch (e) {
    return err(WorkConsoleErrors.io(absPath, 'append', describeIo(e)));
  }
  return ok({
    bytesAppended: Buffer.byteLength(withNewline, 'utf-8'),
    absolutePath: absPath,
  });
}

export function safeAppendJsonl(absPath: string, line: string): ResultAsync<AppendJsonlOk, WorkConsoleError> {
  return wrapResultPromise(appendJsonlImpl(absPath, line));
}

async function safeStatImpl(absPath: string): Promise<Result<{ exists: boolean; isDir: boolean }, WorkConsoleError>> {
  try {
    const info = await stat(absPath);
    return ok({ exists: true, isDir: info.isDirectory() });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return ok({ exists: false, isDir: false });
    }
    return err(WorkConsoleErrors.io(absPath, 'stat', describeIo(e)));
  }
}

export function safeStat(absPath: string): ResultAsync<{ exists: boolean; isDir: boolean }, WorkConsoleError> {
  return wrapResultPromise(safeStatImpl(absPath));
}

/**
 * Bridge from `Promise<Result<T, E>>` to `ResultAsync<T, E>`. The `*Impl`
 * helpers above catch every IO failure and return a typed `Result`, so
 * the inner promise never rejects — `fromSafePromise` is the right
 * combinator. The trailing `.andThen` flattens `Result` into `ResultAsync`.
 *
 * Exported because `feedback.ts` reuses the same shape; keeping it local
 * to one file led to copy-paste drift in an earlier iteration.
 */
export function wrapResultPromise<T, E>(p: Promise<Result<T, E>>): ResultAsync<T, E> {
  return ResultAsync.fromSafePromise(p).andThen<T, E>((inner) =>
    inner.isOk() ? okAsync(inner.value) : errAsync(inner.error),
  );
}

// Internal use of `consoleDir` is via the direct `./paths.ts` import in
// each tool file; no need to re-export from here.
