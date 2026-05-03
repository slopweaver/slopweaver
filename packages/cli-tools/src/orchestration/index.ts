/**
 * Thin wrappers between cac and the orchestration runtime.
 *
 * `cli.ts` registers `orchestration prepare` and `orchestration run` cac
 * commands; their `.action(...)` handlers call `prepare()` / `run()` here,
 * which translate the cac options object into the typed
 * `PrepareOrchestrationOptions` / `RunOrchestrationOptions` the runtime expects.
 */

import type { ExecutorMode } from './core.ts';
import { prepareOrchestration, runOrchestration } from './runtime.ts';

export interface PrepareCliOptions {
  executor: ExecutorMode;
  restart: boolean;
}

export interface RunCliOptions {
  executor: ExecutorMode;
  dryRun: boolean;
  notify: boolean;
  restart: boolean;
}

function normalizeExecutor(raw: string): ExecutorMode {
  if (raw !== 'hybrid' && raw !== 'codex-only') {
    throw new Error(`Unsupported executor: ${raw}. Use 'hybrid' or 'codex-only'.`);
  }
  return raw;
}

export async function prepare(chainPath: string, options: PrepareCliOptions): Promise<void> {
  await prepareOrchestration({
    options: {
      chainInputPath: chainPath,
      executor: options.executor,
      restart: options.restart,
    },
  });
}

export async function run(chainPath: string, options: RunCliOptions): Promise<void> {
  await runOrchestration({
    options: {
      chainInputPath: chainPath,
      dryRun: options.dryRun,
      executor: options.executor,
      notify: options.notify,
      restart: options.restart,
    },
  });
}

export { normalizeExecutor };
