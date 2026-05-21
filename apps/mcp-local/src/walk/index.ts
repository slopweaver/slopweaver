/**
 * `slopweaver walk` CLI runner. Reads the local
 * `.claude/personal/state/reconciliation.md`, parses the `## Walk
 * order` section, prints the queue to stdout. Read-only first cut —
 * the interactive verb-loop (do / agent / handoff / etc) lands in a
 * follow-up PR.
 *
 * Every side effect is injected so the runner is fully testable
 * without a real filesystem.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseWalkOrder } from './parse-walk-order.ts';
import { renderWalkQueue } from './render-walk-queue.ts';

const DEFAULT_REL_PATH = '.claude/personal/state/reconciliation.md';

export type RunWalkDeps = {
  cwd: string;
  readFile?: (absPath: string) => Promise<string>;
  stdout: { write: (s: string) => void };
};

export async function runWalk(deps: RunWalkDeps): Promise<number> {
  const reader = deps.readFile ?? ((p) => readFile(p, 'utf-8'));
  const path = join(deps.cwd, DEFAULT_REL_PATH);
  let content: string;
  try {
    content = await reader(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      deps.stdout.write(renderWalkQueue([]));
      return 0;
    }
    deps.stdout.write(`slopweaver walk: failed to read ${path}: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  const result = parseWalkOrder(content);
  if (result.isErr()) {
    deps.stdout.write(`slopweaver walk: ${result.error.message}\n`);
    return 1;
  }
  deps.stdout.write(renderWalkQueue(result.value));
  return 0;
}

export { renderWalkQueue } from './render-walk-queue.ts';
export type { WalkItem } from './parse-walk-order.ts';
