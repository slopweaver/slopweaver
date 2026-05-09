/**
 * `pnpm cli check-service-boundaries`
 *
 * CI-shaped guard: scans the configured service-boundary files for
 * `throw` statements and reports findings. Service code must return
 * `Result<T, E>` instead of throwing; this check is the gate (per
 * `.claude/rules/error-handling.md` and #41).
 *
 * Wiring into `pnpm validate` is intentionally deferred until Phase 6 of
 * the migration — pre-migration the boundary files contain ~37 existing
 * throws, so flipping the gate on now would lock validate red until
 * every migration commit lands. The check is runnable on demand
 * (`pnpm check:service-boundaries` script) so each migration commit can
 * verify locally that the count is going down.
 */

import { findMonorepoRoot } from '../lib/paths.ts';
import { listBoundaryFiles, scanFiles, type ThrowFinding } from './core.ts';

interface CheckResult {
  readonly ok: boolean;
  readonly findings: ReadonlyArray<ThrowFinding>;
}

function runCheck({ root = findMonorepoRoot() }: { root?: string } = {}): CheckResult {
  const paths = listBoundaryFiles({ root });
  const findings = scanFiles({ root, paths });
  return { ok: findings.length === 0, findings };
}

function printReport({
  result,
  out = console.log,
  err = console.error,
}: {
  result: CheckResult;
  out?: (line: string) => void;
  err?: (line: string) => void;
}): void {
  if (result.ok) {
    out('OK: no `throw` statements in service-boundary files.');
    return;
  }
  err('');
  err(`ERROR: ${result.findings.length} \`throw\` site(s) found in service-boundary files.`);
  err('Service code must return Result<T, E> via @slopweaver/errors instead of throwing.');
  err('See .claude/rules/error-handling.md.');
  err('');
  err('Findings:');
  for (const finding of result.findings) {
    err(`  ${finding.file}:${finding.line}  ${finding.text.trim()}`);
  }
  err('');
}

export function runAndExit(): void {
  const result = runCheck();
  printReport({ result });
  if (!result.ok) {
    process.exit(1);
  }
}
