/**
 * `pnpm cli check-cassette-quality`
 *
 * CI-shaped guard: scans every committed Polly HAR cassette under the
 * integration packages for auth/recording-failure signals that indicate
 * the cassette was recorded against an expired token / unauthenticated
 * session. See `.claude/rules/testing.md` (cassette quality is
 * automated).
 *
 * Wired into `pnpm validate`. Runnable on demand via
 * `pnpm cli check-cassette-quality`.
 */

import { findMonorepoRoot } from '../lib/paths.ts';
import { listCassetteFiles, scanFiles, type Violation } from './core.ts';

interface CheckResult {
  readonly ok: boolean;
  readonly violations: ReadonlyArray<Violation>;
}

function runCheck({ root }: { root: string }): CheckResult {
  const paths = listCassetteFiles({ root });
  const violations = scanFiles({ root, paths });
  return { ok: violations.length === 0, violations };
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
    out('OK: no Polly cassettes contain auth/recording-failure signals.');
    return;
  }
  err('');
  err(`ERROR: ${result.violations.length} suspicious response(s) in committed cassettes.`);
  err('Likely cause: re-recorded with `POLLY_MODE=record` against an expired token.');
  err(
    'Fix: refresh the token, re-record, and verify the diff has no 401/403/invalid_grant signals.',
  );
  err('Exempt paths must contain one of: auth, refresh, error, expired, invalid, oauth, etc.');
  err('See .claude/rules/testing.md.');
  err('');
  err('Findings:');
  for (const v of result.violations) {
    err(`  ${v.file}`);
    err(`    ${v.text}`);
  }
  err('');
}

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
