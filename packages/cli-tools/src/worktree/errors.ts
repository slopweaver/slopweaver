/**
 * Errors that can arise from the worktree-new subcommand.
 *
 * `exitCode` is carried on every variant so the CLI boundary can pass it
 * straight to `process.exit(...)` without re-deriving it from the
 * discriminant.
 */

import type { BaseError } from '@slopweaver/errors';

export interface WorktreeInvalidNameError extends BaseError {
  readonly code: 'WORKTREE_INVALID_NAME';
  readonly exitCode: number;
}

export interface WorktreeGitFetchFailedError extends BaseError {
  readonly code: 'WORKTREE_GIT_FETCH_FAILED';
  readonly exitCode: number;
}

export interface WorktreeGitAddFailedError extends BaseError {
  readonly code: 'WORKTREE_GIT_ADD_FAILED';
  readonly exitCode: number;
}

export interface WorktreePnpmInstallFailedError extends BaseError {
  readonly code: 'WORKTREE_PNPM_INSTALL_FAILED';
  readonly exitCode: number;
}

export type WorktreeError =
  | WorktreeInvalidNameError
  | WorktreeGitFetchFailedError
  | WorktreeGitAddFailedError
  | WorktreePnpmInstallFailedError;

export const WorktreeErrors = {
  invalidName: (message: string): WorktreeInvalidNameError => ({
    code: 'WORKTREE_INVALID_NAME',
    message,
    exitCode: 1,
  }),
  gitFetchFailed: (exitCode: number): WorktreeGitFetchFailedError => ({
    code: 'WORKTREE_GIT_FETCH_FAILED',
    message: 'git fetch origin main failed',
    exitCode,
  }),
  gitAddFailed: (exitCode: number): WorktreeGitAddFailedError => ({
    code: 'WORKTREE_GIT_ADD_FAILED',
    message: 'git worktree add failed',
    exitCode,
  }),
  pnpmInstallFailed: (exitCode: number): WorktreePnpmInstallFailedError => ({
    code: 'WORKTREE_PNPM_INSTALL_FAILED',
    message: 'pnpm install failed',
    exitCode,
  }),
} as const;
