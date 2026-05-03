import { spawnSync } from 'node:child_process';
import { accessSync, constants as fsConstants, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { resolveDataDir } from '../lib/data-dir.ts';

export const REQUIRED_NODE_MAJOR = 22;
export const REQUIRED_PNPM_MAJOR = 10;
export const LOCAL_API_PORT = 60701;
export const PNPM_VERSION_TIMEOUT_MS = 5_000;

export type CheckStatus = 'ok' | 'warn' | 'fail';
export type Fixable = 'create-data-dir';

export type CheckResult = {
  name: string;
  status: CheckStatus;
  detail: string;
  fixable?: Fixable;
};

function majorOf(version: string): number {
  return Number.parseInt(version.split('.')[0] ?? '0', 10);
}

export function checkNodeVersion({
  nodeVersion = process.versions.node,
}: {
  nodeVersion?: string;
} = {}): CheckResult {
  const major = majorOf(nodeVersion);
  if (major >= REQUIRED_NODE_MAJOR) {
    return {
      name: 'Node version',
      status: 'ok',
      detail: `node ${nodeVersion} (>=${REQUIRED_NODE_MAJOR})`,
    };
  }
  return {
    name: 'Node version',
    status: 'fail',
    detail: `node ${nodeVersion} -- need >=${REQUIRED_NODE_MAJOR} (see .nvmrc)`,
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
} = {}): CheckResult {
  const result = getVersion();
  if (!result.ok) {
    if (result.reason === 'not-found') {
      return {
        name: 'pnpm version',
        status: 'fail',
        detail:
          'pnpm not on PATH (install: corepack enable && corepack prepare pnpm@latest --activate)',
      };
    }
    if (result.reason === 'timeout') {
      return {
        name: 'pnpm version',
        status: 'fail',
        detail: `pnpm --version timed out after ${PNPM_VERSION_TIMEOUT_MS}ms (broken corepack shim?)`,
      };
    }
    return {
      name: 'pnpm version',
      status: 'fail',
      detail: `pnpm --version failed: ${result.detail ?? 'unknown error'}`,
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
    status: 'fail',
    detail: `pnpm ${result.version} -- need >=${REQUIRED_PNPM_MAJOR} (run: corepack prepare pnpm@latest --activate)`,
  };
}

export type TryBindResult = { ok: true } | { ok: false; code: string };
export type TryBindFn = (port: number) => Promise<TryBindResult>;

const defaultTryBind: TryBindFn = (port) =>
  new Promise((resolve) => {
    const server = createServer();
    let settled = false;
    const settle = (result: TryBindResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    server.once('error', (err) => {
      const code = (err as NodeJS.ErrnoException).code ?? 'unknown';
      settle({ ok: false, code });
    });
    server.listen(port, '127.0.0.1', () => {
      server.close(() => settle({ ok: true }));
    });
  });

export async function checkPortFree({
  port,
  tryBind = defaultTryBind,
}: {
  port: number;
  tryBind?: TryBindFn;
}): Promise<CheckResult> {
  const result = await tryBind(port);
  if (result.ok) {
    return {
      name: `Port ${port} free`,
      status: 'ok',
      detail: `port ${port} available`,
    };
  }
  if (result.code === 'EADDRINUSE') {
    return {
      name: `Port ${port} free`,
      status: 'fail',
      detail: `port ${port} is in use (kill the process bound to it, then re-run)`,
    };
  }
  return {
    name: `Port ${port} free`,
    status: 'fail',
    detail: `failed to probe port ${port}: ${result.code}`,
  };
}

export const CODEX_HEALTH_TIMEOUT_MS = 10_000;

export type CodexHealthResult =
  | { kind: 'not-installed' }
  | { kind: 'healthy'; summary: string }
  | { kind: 'unhealthy'; detail: string }
  | { kind: 'timeout' }
  | { kind: 'error'; detail: string };

function defaultGetCodexHealth(): CodexHealthResult {
  const result = spawnSync('codex-agent', ['health'], {
    encoding: 'utf8',
    timeout: CODEX_HEALTH_TIMEOUT_MS,
  });
  if (result.error) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'not-installed' };
    return { kind: 'error', detail: code ?? result.error.message };
  }
  if (result.signal === 'SIGTERM') return { kind: 'timeout' };
  if (result.status !== 0) {
    const detail = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
    return { kind: 'unhealthy', detail };
  }
  const summary = (result.stdout ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join(', ')
    .slice(0, 120);
  return { kind: 'healthy', summary };
}

/**
 * Returns null when `codex-agent` is not on PATH — codex is optional, so
 * contributors who don't use it see no noise in `pnpm cli doctor` output.
 * Returns a CheckResult only when the binary is installed (healthy or not).
 */
export function checkCodexAgent({
  getHealth = defaultGetCodexHealth,
}: {
  getHealth?: () => CodexHealthResult;
} = {}): CheckResult | null {
  const result = getHealth();
  if (result.kind === 'not-installed') {
    return null;
  }
  if (result.kind === 'healthy') {
    return {
      name: 'Codex orchestrator',
      status: 'ok',
      detail: result.summary || 'codex-agent health: Ready',
    };
  }
  if (result.kind === 'timeout') {
    return {
      name: 'Codex orchestrator',
      status: 'fail',
      detail: `codex-agent health timed out after ${CODEX_HEALTH_TIMEOUT_MS}ms (likely tmux passthrough; add 'set -g allow-passthrough on' to ~/.tmux.conf)`,
    };
  }
  if (result.kind === 'unhealthy') {
    return {
      name: 'Codex orchestrator',
      status: 'fail',
      detail: `codex-agent health failed: ${result.detail || 'unknown'}`,
    };
  }
  return {
    name: 'Codex orchestrator',
    status: 'fail',
    detail: `codex-agent health error: ${result.detail || 'unknown'}`,
  };
}

export function checkDataDir({
  dataDir = resolveDataDir(),
}: {
  dataDir?: string;
} = {}): CheckResult {
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
    return {
      name: 'Data dir',
      status: 'ok',
      detail: `${dataDir} (writable)`,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        name: 'Data dir',
        status: 'warn',
        detail: `${dataDir} (missing -- will offer to create)`,
        fixable: 'create-data-dir',
      };
    }
    if (code === 'EACCES' || code === 'EPERM') {
      return {
        name: 'Data dir',
        status: 'fail',
        detail: `${dataDir} (exists but not writable: ${code})`,
      };
    }
    return {
      name: 'Data dir',
      status: 'fail',
      detail: `${dataDir} (filesystem error: ${code ?? 'unknown'})`,
    };
  }
}
