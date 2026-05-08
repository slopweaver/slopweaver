/**
 * Environment health checks for the Diagnostics page.
 *
 * Intentional partial duplicate of `packages/cli-tools/src/doctor/checks.ts`.
 * `cli-tools` is `private: true` with no build step (its `main` points at TS
 * source), so it cannot be safely consumed by published runtime packages.
 * Once cli-tools gains a build (or we extract a runtime-safe
 * `@slopweaver/diagnostics-core`), collapse this back to a single source of
 * truth.
 *
 * Intentional divergences from the cli-tools original:
 *  - pnpm failures are downgraded from `fail` to `warn`. Reasoning: the
 *    Diagnostics page is shown to end users running the published binary,
 *    where pnpm is irrelevant (only matters for contributors building from
 *    source). The cli-tools doctor still reports `fail` because it is a
 *    contributor-facing tool.
 *
 * Checks are pure-with-injected-deps so tests don't shell out.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import type { EnvCheck } from './types.ts';

const REQUIRED_NODE_MAJOR = 22;
const REQUIRED_NODE_MINOR = 12;
const REQUIRED_PNPM_MAJOR = 10;
const PNPM_VERSION_TIMEOUT_MS = 5_000;

function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '0', 10);
}

function minorOf(version: string): number {
  return Number.parseInt(version.split('.')[1] ?? '0', 10);
}

function isNodeSupported(version: string): boolean {
  const major = majorOf(version);
  if (major > REQUIRED_NODE_MAJOR) return true;
  if (major < REQUIRED_NODE_MAJOR) return false;
  return minorOf(version) >= REQUIRED_NODE_MINOR;
}

export function checkNodeVersion({
  nodeVersion = process.versions.node,
}: {
  nodeVersion?: string;
} = {}): EnvCheck {
  const required = `${REQUIRED_NODE_MAJOR}.${REQUIRED_NODE_MINOR}`;
  if (isNodeSupported(nodeVersion)) {
    return {
      name: 'Node version',
      status: 'ok',
      detail: `node ${nodeVersion} (>=${required})`,
    };
  }
  return {
    name: 'Node version',
    status: 'fail',
    detail: `node ${nodeVersion} -- need >=${required}`,
  };
}

export type GetVersionResult =
  | { ok: true; version: string }
  | { ok: false; reason: 'not-found' | 'timeout' | 'error'; detail?: string };

function defaultGetPnpmVersion(): GetVersionResult {
  const result = spawnSync('pnpm', ['--version'], {
    encoding: 'utf8',
    timeout: PNPM_VERSION_TIMEOUT_MS,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, reason: 'not-found' };
    return { ok: false, reason: 'error', detail: code ?? result.error.message };
  }
  if (result.signal === 'SIGTERM') {
    return { ok: false, reason: 'timeout' };
  }
  if (result.status !== 0) {
    return { ok: false, reason: 'error', detail: `exit ${result.status}` };
  }
  return { ok: true, version: result.stdout.trim() };
}

export function checkPnpmVersion({
  getVersion = defaultGetPnpmVersion,
}: {
  getVersion?: () => GetVersionResult;
} = {}): EnvCheck {
  const result = getVersion();
  if (!result.ok) {
    if (result.reason === 'not-found') {
      return {
        name: 'pnpm version',
        status: 'warn',
        detail: 'pnpm not on PATH (only relevant for local development)',
      };
    }
    if (result.reason === 'timeout') {
      return {
        name: 'pnpm version',
        status: 'warn',
        detail: `pnpm --version timed out after ${PNPM_VERSION_TIMEOUT_MS}ms`,
      };
    }
    return {
      name: 'pnpm version',
      status: 'warn',
      detail: `pnpm --version failed: ${result.detail ?? 'unknown'}`,
    };
  }
  const major = majorOf(result.version);
  if (major >= REQUIRED_PNPM_MAJOR) {
    return {
      name: 'pnpm version',
      status: 'ok',
      detail: `pnpm ${result.version} (>=${REQUIRED_PNPM_MAJOR})`,
    };
  }
  return {
    name: 'pnpm version',
    status: 'warn',
    detail: `pnpm ${result.version} -- recommended >=${REQUIRED_PNPM_MAJOR}`,
  };
}

export function checkDataDir({ dataDir }: { dataDir: string }): EnvCheck {
  try {
    const stats = statSync(dataDir);
    if (!stats.isDirectory()) {
      return {
        name: 'Data dir',
        status: 'fail',
        detail: `${dataDir} (exists but is not a directory)`,
      };
    }
    accessSync(dataDir, fsConstants.W_OK);
    return { name: 'Data dir', status: 'ok', detail: `${dataDir} (writable)` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return { name: 'Data dir', status: 'warn', detail: `${dataDir} (missing)` };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        name: 'Data dir',
        status: 'fail',
        detail: `${dataDir} (not writable: ${code})`,
      };
    }
    return {
      name: 'Data dir',
      status: 'fail',
      detail: `${dataDir} (filesystem error: ${code ?? 'unknown'})`,
    };
  }
}

export type StaticEnvChecks = {
  node: EnvCheck;
  pnpm: EnvCheck;
  dataDir: EnvCheck;
};

/**
 * Run all env checks once at server start. Cheap (synchronous, no network);
 * the result is cached for the life of the server because none of these
 * values change at runtime.
 */
export function runStaticEnvChecks({ dataDir }: { dataDir: string }): StaticEnvChecks {
  return {
    node: checkNodeVersion(),
    pnpm: checkPnpmVersion(),
    dataDir: checkDataDir({ dataDir }),
  };
}
