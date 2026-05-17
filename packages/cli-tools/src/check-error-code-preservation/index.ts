/**
 * `pnpm cli check-error-code-preservation`
 *
 * CI-shaped guard: scans `packages/**` and `apps/**` source for
 * `.mapErr()` callbacks that build an error object with `message` but
 * drop the `code` discriminant. See `.claude/rules/error-handling.md`
 * — every domain error has a `code` field, and `.mapErr` translations
 * must thread it through so callers can still branch on the typed
 * union.
 *
 * Wired into `pnpm validate`. Runnable on demand via
 * `pnpm cli check-error-code-preservation`.
 */

import { findMonorepoRoot } from '../lib/paths.ts';
import { listScanFiles, scanFiles, type Violation } from './core.ts';

function runCheck({ root }: { root: string }): {
  ok: boolean;
  violations: ReadonlyArray<Violation>;
} {
  const paths = listScanFiles({ root });
  const violations = scanFiles({ root, paths });
  return { ok: violations.length === 0, violations };
}

function printReport({
  result,
  out = console.log,
  err = console.error,
}: {
  result: { ok: boolean; violations: ReadonlyArray<Violation> };
  out?: (line: string) => void;
  err?: (line: string) => void;
}): void {
  if (result.ok) {
    out('OK: no `.mapErr()` calls drop the `code` field.');
    return;
  }
  err('');
  err(`ERROR: ${result.violations.length} \`.mapErr()\` call(s) drop the \`code\` field.`);
  err('Every typed error union carries a `code` discriminant; preserve it.');
  err('Fix: .mapErr((e) => ({ code: e.code, message: e.message, ... }))');
  err('See .claude/rules/error-handling.md.');
  err('');
  err('Findings:');
  for (const v of result.violations) {
    err(`  ${v.file}:${v.line}  ${v.text}`);
  }
  err('');
}

/**
 * CLI entry point. Resolves the monorepo root, walks `packages/` + `apps/`,
 * prints a CodeRabbit-style report, and exits non-zero on any finding.
 *
 * @returns never — calls `process.exit` on both success and failure paths.
 */
export function runAndExit(): void {
  const rootResult = findMonorepoRoot();
  if (rootResult.isErr()) {
    console.error(rootResult.error.message);
    process.exit(1);
  }
  const result = runCheck({ root: rootResult.value });
  printReport({ result });
  if (!result.ok) {
    process.exit(1);
  }
}
