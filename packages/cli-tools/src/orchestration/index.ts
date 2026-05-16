/**
 * Thin wrappers between cac and the orchestration runtime.
 *
 * `cli.ts` registers `orchestration prepare` and `orchestration run` cac
 * commands; their `.action(...)` handlers call `prepare()` / `run()` here,
 * which translate the cac options object into the typed
 * `PrepareOrchestrationOptions` / `RunOrchestrationOptions` the runtime expects.
 *
 * Both wrappers return a `Result` from the runtime; the CLI dispatcher
 * `.match()`es and exits non-zero on Err.
 */

import { err, ok, type Result } from '@slopweaver/errors';
import type { MonorepoRootNotFoundError } from '../lib/errors.ts';
import type { ExecutorMode } from './core.ts';
import type { OrchestrationError } from './errors.ts';
import { prepareOrchestration, runOrchestration } from './runtime.ts';

interface PrepareCliOptions {
  executor: ExecutorMode;
  restart: boolean;
}

interface RunCliOptions {
  executor: ExecutorMode;
  dryRun: boolean;
  notify: boolean;
  restart: boolean;
}

interface UnsupportedExecutorError {
  readonly code: 'ORCHESTRATION_UNSUPPORTED_EXECUTOR';
  readonly message: string;
  readonly raw: string;
}

function normalizeExecutor(raw: string): Result<ExecutorMode, UnsupportedExecutorError> {
  if (raw !== 'hybrid' && raw !== 'codex-only') {
    return err({
      code: 'ORCHESTRATION_UNSUPPORTED_EXECUTOR',
      message: `Unsupported executor: ${raw}. Use 'hybrid' or 'codex-only'.`,
      raw,
    });
  }
  return ok(raw);
}

export async function prepare(
  chainPath: string,
  options: PrepareCliOptions,
): Promise<Result<void, OrchestrationError | MonorepoRootNotFoundError>> {
  return await prepareOrchestration({
    options: {
      chainInputPath: chainPath,
      executor: options.executor,
      restart: options.restart,
    },
  });
}

export async function run(
  chainPath: string,
  options: RunCliOptions,
): Promise<Result<void, OrchestrationError | MonorepoRootNotFoundError>> {
  return await runOrchestration({
    options: {
      chainInputPath: chainPath,
      dryRun: options.dryRun,
      executor: options.executor,
      notify: options.notify,
      restart: options.restart,
    },
  });
}

export { normalizeExecutor, type UnsupportedExecutorError };
