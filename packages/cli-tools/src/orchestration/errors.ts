/**
 * Errors for the orchestration runtime + parsers.
 *
 * Covers the pure-parser failures in core.ts (commit 16) plus the
 * subprocess + state-machine failures the runtime.ts split exposes in
 * later commits. The union is stable from commit 16 onward so consumers
 * don't have to re-match as commits 18-20 land.
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

// Note: the umbrella `OrchestrationError` union lands in commit 18 once
// commits 18-20 add the runtime-side error codes. For commit 16 the three
// parser variants are surfaced individually since each parser returns its
// specific error type.

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
} as const;
