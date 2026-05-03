/**
 * `pnpm cli doctor`
 *
 * Checks that the local environment is ready for SlopWeaver development:
 * Node version, pnpm version, the local API port, and the data directory.
 *
 * Each check is a pure function in `./checks.ts`. This file orchestrates
 * them: runs each, prints the result with a colored status icon, and (if
 * the data dir is missing) prompts to create it. Returns a result object;
 * the dispatcher in `cli.ts` maps that to a process exit code.
 *
 * `prompt` and `mkdir` are injectable so the orchestrator stays unit-
 * testable without touching real stdin or filesystem.
 */

import { confirm } from '@inquirer/prompts';
import { mkdirSync } from 'node:fs';
import pc from 'picocolors';
import { resolveDataDir } from '../lib/data-dir.ts';
import {
  type CheckResult,
  LOCAL_API_PORT,
  checkCodexAgent,
  checkDataDir,
  checkNodeVersion,
  checkPnpmVersion,
  checkPortFree,
} from './checks.ts';

export type RunDoctorDeps = {
  prompt?: (message: string) => Promise<boolean>;
  mkdir?: (path: string) => void;
  log?: (line: string) => void;
};

export type RunDoctorResult = { ok: true } | { ok: false; failed: number; exitCode: number };

const ICON: Record<CheckResult['status'], string> = {
  ok: pc.green('✓'),
  warn: pc.yellow('!'),
  fail: pc.red('✗'),
};

function formatRow(result: CheckResult): string {
  return `${ICON[result.status]} ${pc.bold(result.name)}  ${pc.dim(result.detail)}`;
}

const defaultPrompt = async (message: string): Promise<boolean> =>
  confirm({ message, default: true });

const defaultMkdir = (path: string): void => {
  mkdirSync(path, { recursive: true });
};

export async function runDoctor({
  prompt = defaultPrompt,
  mkdir = defaultMkdir,
  log = console.log,
}: RunDoctorDeps = {}): Promise<RunDoctorResult> {
  log(pc.bold('SlopWeaver doctor'));
  log('');

  const codexResult = checkCodexAgent();
  const results: CheckResult[] = [
    checkNodeVersion(),
    checkPnpmVersion(),
    await checkPortFree({ port: LOCAL_API_PORT }),
    checkDataDir(),
    ...(codexResult ? [codexResult] : []),
  ];

  for (const result of results) {
    log(formatRow(result));
  }

  // Offer the one fix we know how to apply.
  const dataDirIndex = results.findIndex((r) => r.fixable === 'create-data-dir');
  if (dataDirIndex !== -1) {
    const dataDir = resolveDataDir();
    log('');
    const shouldCreate = await prompt(`Create data dir at ${dataDir}?`);
    if (shouldCreate) {
      mkdir(dataDir);
      const recheck = checkDataDir();
      results[dataDirIndex] = recheck;
      log(formatRow(recheck));
    }
  }

  const failed = results.filter((r) => r.status === 'fail').length;
  const warned = results.filter((r) => r.status === 'warn').length;
  log('');
  if (failed === 0 && warned === 0) {
    log(pc.green('All good. You are ready to develop.'));
    return { ok: true };
  }
  if (failed === 0) {
    log(pc.yellow(`OK with ${warned} warning${warned === 1 ? '' : 's'} (see above).`));
    return { ok: true };
  }
  log(pc.red(`${failed} check${failed === 1 ? '' : 's'} failed. Fix the items above and re-run.`));
  return { ok: false, failed, exitCode: 1 };
}
