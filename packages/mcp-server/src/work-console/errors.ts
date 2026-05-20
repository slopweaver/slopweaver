/**
 * Work-console error union. The work-console subsystem owns: branch
 * enforcement, console-dir CRUD, feedback log append, calibration report.
 * Every fallible function returns `ResultAsync<T, WorkConsoleError>`.
 */

import type { BaseError } from '@slopweaver/errors';

export interface WorkConsoleNoGitRepoError extends BaseError {
  readonly code: 'WORK_CONSOLE_NO_GIT_REPO';
  readonly cwd: string;
}

export interface WorkConsoleGitFailedError extends BaseError {
  readonly code: 'WORK_CONSOLE_GIT_FAILED';
  readonly command: string;
  readonly exitCode: number | null;
  readonly stderr: string;
}

export interface WorkConsoleDirtyWorktreeError extends BaseError {
  readonly code: 'WORK_CONSOLE_DIRTY_WORKTREE';
  readonly branch: string;
  readonly status: string;
}

export interface WorkConsolePathOutsideError extends BaseError {
  readonly code: 'WORK_CONSOLE_PATH_OUTSIDE';
  readonly attempted: string;
  readonly consoleDir: string;
}

export interface WorkConsoleFileMissingError extends BaseError {
  readonly code: 'WORK_CONSOLE_FILE_MISSING';
  readonly path: string;
}

export interface WorkConsoleIoError extends BaseError {
  readonly code: 'WORK_CONSOLE_IO_FAILED';
  readonly path: string;
  readonly operation: 'read' | 'write' | 'list' | 'mkdir' | 'stat' | 'append';
}

export type WorkConsoleError =
  | WorkConsoleNoGitRepoError
  | WorkConsoleGitFailedError
  | WorkConsoleDirtyWorktreeError
  | WorkConsolePathOutsideError
  | WorkConsoleFileMissingError
  | WorkConsoleIoError;

export const WorkConsoleErrors = {
  noGitRepo: (cwd: string): WorkConsoleNoGitRepoError => ({
    code: 'WORK_CONSOLE_NO_GIT_REPO',
    message: `not inside a git repo (cwd: ${cwd})`,
    cwd,
  }),
  gitFailed: (command: string, exitCode: number | null, stderr: string): WorkConsoleGitFailedError => ({
    code: 'WORK_CONSOLE_GIT_FAILED',
    message: `git ${command} failed (exit ${exitCode ?? 'null'}): ${stderr.trim().length > 0 ? stderr.trim() : 'no stderr'}`,
    command,
    exitCode,
    stderr,
  }),
  dirtyWorktree: (branch: string, status: string): WorkConsoleDirtyWorktreeError => ({
    code: 'WORK_CONSOLE_DIRTY_WORKTREE',
    message: `cannot switch to branch ${branch}: working tree has uncommitted changes`,
    branch,
    status,
  }),
  pathOutside: (attempted: string, consoleDir: string): WorkConsolePathOutsideError => ({
    code: 'WORK_CONSOLE_PATH_OUTSIDE',
    message: `path ${attempted} resolves outside the console directory ${consoleDir}`,
    attempted,
    consoleDir,
  }),
  fileMissing: (path: string): WorkConsoleFileMissingError => ({
    code: 'WORK_CONSOLE_FILE_MISSING',
    message: `file not found: ${path}`,
    path,
  }),
  io: (path: string, operation: WorkConsoleIoError['operation'], detail: string): WorkConsoleIoError => ({
    code: 'WORK_CONSOLE_IO_FAILED',
    message: `${operation} failed for ${path}: ${detail}`,
    path,
    operation,
  }),
} as const;
