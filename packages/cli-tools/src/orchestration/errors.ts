/**
 * Errors for the orchestration runtime + parsers.
 *
 * Discriminated by `code`. Service code returns `Result<T, OrchestrationError>`
 * (or one of the constituent variants); callers exhaustively match on `code`
 * at the boundary.
 *
 * The union covers:
 * - Parser failures in core.ts (parseOrchestrationChain, parseCodexJobId,
 *   parsePullRequestUrl).
 * - State preconditions in runtime.ts (worktree merge conflicts, dirty
 *   worktree, missing planning prompt).
 * - The model-attempt classifier (`OrchestrationModelAttemptError`) that
 *   tags transient vs fatal so the retry-fallback loops can decide whether
 *   to continue to the next candidate.
 * - Subprocess failures from `createDefaultEnvironment` wrappers
 *   (`OrchestrationSubprocessFailedError`).
 * - Terminal "no more retries" errors (all models failed, review loop
 *   exhausted, CI loop exhausted, CI run id missing for diagnosis).
 */

import type { BaseError } from '@slopweaver/errors';

// ---------- core.ts parsers ----------

export interface OrchestrationMissingTitleError extends BaseError {
  readonly code: 'ORCHESTRATION_MISSING_TITLE';
  readonly chainPath: string;
}

export interface OrchestrationInvalidJobIdOutputError extends BaseError {
  readonly code: 'ORCHESTRATION_INVALID_JOB_ID_OUTPUT';
  readonly output: string;
}

export interface OrchestrationInvalidPrUrlOutputError extends BaseError {
  readonly code: 'ORCHESTRATION_INVALID_PR_URL_OUTPUT';
  readonly output: string;
}

// ---------- runtime.ts state preconditions ----------

export interface OrchestrationWorktreeMergeConflictError extends BaseError {
  readonly code: 'ORCHESTRATION_WORKTREE_MERGE_CONFLICT';
  readonly worktreePath: string;
}

export interface OrchestrationWorktreeDirtyError extends BaseError {
  readonly code: 'ORCHESTRATION_WORKTREE_DIRTY';
  readonly worktreePath: string;
}

export interface OrchestrationMissingPlanPromptError extends BaseError {
  readonly code: 'ORCHESTRATION_MISSING_PLAN_PROMPT';
  readonly chainPath: string;
}

// ---------- runtime.ts retry-loop classifier ----------

/**
 * Carries the classification needed by the model-attempt retry loops: a
 * `transient` failure tells the outer loop to advance to the next candidate;
 * `fatal` tells it to bubble out immediately. `lastError` is the captured
 * stderr/stdout used for the "All model attempts failed" summary.
 */
export interface OrchestrationModelAttemptError extends BaseError {
  readonly code: 'ORCHESTRATION_MODEL_ATTEMPT';
  readonly kind: 'transient' | 'fatal';
  readonly lastError: string;
}

export interface OrchestrationAllModelsFailedError extends BaseError {
  readonly code: 'ORCHESTRATION_ALL_MODELS_FAILED';
  readonly retryKey: string;
  readonly lastError: string;
}

// ---------- runtime.ts terminal loop failures ----------

export interface OrchestrationReviewNotConvergedError extends BaseError {
  readonly code: 'ORCHESTRATION_REVIEW_NOT_CONVERGED';
  readonly attempts: number;
  readonly runDirectory: string;
}

export interface OrchestrationCiNotConvergedError extends BaseError {
  readonly code: 'ORCHESTRATION_CI_NOT_CONVERGED';
  readonly attempts: number;
  readonly runDirectory: string;
}

export interface OrchestrationCiRunIdMissingError extends BaseError {
  readonly code: 'ORCHESTRATION_CI_RUN_ID_MISSING';
}

// ---------- runtime.ts subprocess wrappers ----------

export interface OrchestrationSubprocessFailedError extends BaseError {
  readonly code: 'ORCHESTRATION_SUBPROCESS_FAILED';
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly exitCode: number;
  readonly output: string;
}

// ---------- umbrella union + factories ----------

export type OrchestrationError =
  | OrchestrationMissingTitleError
  | OrchestrationInvalidJobIdOutputError
  | OrchestrationInvalidPrUrlOutputError
  | OrchestrationMissingPlanPromptError
  | OrchestrationWorktreeMergeConflictError
  | OrchestrationWorktreeDirtyError
  | OrchestrationModelAttemptError
  | OrchestrationAllModelsFailedError
  | OrchestrationReviewNotConvergedError
  | OrchestrationCiNotConvergedError
  | OrchestrationCiRunIdMissingError
  | OrchestrationSubprocessFailedError;

export const OrchestrationErrors = {
  missingTitle: (chainPath: string): OrchestrationMissingTitleError => ({
    code: 'ORCHESTRATION_MISSING_TITLE',
    message: `Missing top-level title in orchestration chain: ${chainPath}`,
    chainPath,
  }),

  invalidJobIdOutput: (output: string): OrchestrationInvalidJobIdOutputError => ({
    code: 'ORCHESTRATION_INVALID_JOB_ID_OUTPUT',
    message: `Could not parse codex-agent job id from output:\n${output}`,
    output,
  }),

  invalidPrUrlOutput: (output: string): OrchestrationInvalidPrUrlOutputError => ({
    code: 'ORCHESTRATION_INVALID_PR_URL_OUTPUT',
    message: `Could not parse PR URL from output:\n${output}`,
    output,
  }),

  worktreeMergeConflict: (worktreePath: string): OrchestrationWorktreeMergeConflictError => ({
    code: 'ORCHESTRATION_WORKTREE_MERGE_CONFLICT',
    message: `Worktree has merge conflicts: ${worktreePath}`,
    worktreePath,
  }),

  worktreeDirty: (worktreePath: string): OrchestrationWorktreeDirtyError => ({
    code: 'ORCHESTRATION_WORKTREE_DIRTY',
    message: `Worktree is dirty: ${worktreePath}`,
    worktreePath,
  }),

  missingPlanPrompt: (chainPath: string): OrchestrationMissingPlanPromptError => ({
    code: 'ORCHESTRATION_MISSING_PLAN_PROMPT',
    message: `Missing codex-plan prompt in chain: ${chainPath}`,
    chainPath,
  }),

  modelAttempt: ({
    kind,
    lastError,
  }: {
    kind: 'transient' | 'fatal';
    lastError: string;
  }): OrchestrationModelAttemptError => ({
    code: 'ORCHESTRATION_MODEL_ATTEMPT',
    message: `Model attempt failed (${kind}): ${lastError}`,
    kind,
    lastError,
  }),

  allModelsFailed: ({
    retryKey,
    lastError,
  }: {
    retryKey: string;
    lastError: string;
  }): OrchestrationAllModelsFailedError => ({
    code: 'ORCHESTRATION_ALL_MODELS_FAILED',
    message: `All model attempts failed for ${retryKey}.\n${lastError}`,
    retryKey,
    lastError,
  }),

  reviewNotConverged: ({
    attempts,
    runDirectory,
  }: {
    attempts: number;
    runDirectory: string;
  }): OrchestrationReviewNotConvergedError => ({
    code: 'ORCHESTRATION_REVIEW_NOT_CONVERGED',
    message: `Review loop did not converge after ${attempts} attempts. Inspect ${runDirectory}/artifacts/review-${attempts}.md and either resume with --restart, fix the chain, or address findings manually.`,
    attempts,
    runDirectory,
  }),

  ciNotConverged: ({
    attempts,
    runDirectory,
  }: {
    attempts: number;
    runDirectory: string;
  }): OrchestrationCiNotConvergedError => ({
    code: 'ORCHESTRATION_CI_NOT_CONVERGED',
    message: `CI loop did not converge after ${attempts} attempts. Inspect ${runDirectory}/artifacts/ci-watch-${attempts}.md and either resume with --restart, fix the chain, or address failures manually.`,
    attempts,
    runDirectory,
  }),

  ciRunIdMissing: (): OrchestrationCiRunIdMissingError => ({
    code: 'ORCHESTRATION_CI_RUN_ID_MISSING',
    message: 'CI failed but no GitHub run id could be resolved for diagnosis.',
  }),

  subprocessFailed: ({
    command,
    args,
    cwd,
    exitCode,
    output,
  }: {
    command: string;
    args: ReadonlyArray<string>;
    cwd: string;
    exitCode: number;
    output: string;
  }): OrchestrationSubprocessFailedError => ({
    code: 'ORCHESTRATION_SUBPROCESS_FAILED',
    message: `${command} ${args.join(' ')} (cwd=${cwd}) exited ${exitCode}: ${output.trim() || '(no output)'}`,
    command,
    args,
    cwd,
    exitCode,
    output,
  }),
} as const;
