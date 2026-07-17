/**
 * The `dev gate` — the single bar every PR must clear, composed from the three checks the foundation
 * owns: the public hygiene scan, the PR-description format, and the deterministic eval-regression. It
 * runs ALL three (no short-circuit, so one run tells you everything that's wrong), then exits non-zero if
 * any failed. It writes an append-only JSONL run log + the baseline↔candidate diff under
 * `$SLOPWEAVER_HOME/ledgers/`. The same command runs locally and in CI.
 *
 * Pure core / effectful shell: the check evaluators, the compose, and the log-line builder are pure and
 * unit-tested; `runDevGate` is the thin effectful edge that reads the body, runs the real hygiene scan,
 * loads the fixture+baseline, and writes the ledger. (Typecheck + unit tests stay standard build steps —
 * the gate is the leak/format/regression bar the spec names, not a test runner.)
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { validatePrBody } from '../prformat/check.js'
import { EXIT_USAGE } from '../cli/exitCodes.js'
import { parseFlags } from '../cli/parseFlags.js'
import { runScan } from '../hygiene/scan.js'
import { stateHomePaths } from '../stateHome.js'
import type { CorpusRecord } from '../corpus/types.js'
import {
  compareToBaseline,
  fixturePath,
  loadBaseline,
  loadFixtureRecords,
  scoreRecall,
  type RecallBaseline,
  type RegressionDiff,
} from '../eval/regression.js'

/** The three check names the gate composes, in run order. */
export type GateCheckName = 'hygiene' | 'pr-format' | 'eval-regression'

/** One check's outcome — its pass/fail + a one-line human summary for the log and the console. */
export interface GateCheckResult {
  readonly name: GateCheckName
  readonly ok: boolean
  readonly summary: string
}

/** One-decimal percent formatter for summaries — the built-in `Intl.NumberFormat`, no hand-rolled maths. */
const PERCENT_FORMAT = new Intl.NumberFormat('en', { style: 'percent', minimumFractionDigits: 1, maximumFractionDigits: 1 })
function pct({ ratio }: { ratio: number }): string {
  return PERCENT_FORMAT.format(ratio)
}

/**
 * The PR-format check: a present, conforming body passes; a missing/blank body is a failure (never a
 * skip — an unvalidated PR body is not a pass). Pure.
 *
 * @param body the PR description (from `--pr-body-file` or `$PR_BODY`), or undefined
 * @returns the check result
 */
export function prFormatResult({ body }: { body: string | undefined }): GateCheckResult {
  if (body === undefined || body.trim().length === 0) {
    return { name: 'pr-format', ok: false, summary: 'no PR body provided (pass --pr-body-file <path> or set $PR_BODY)' }
  }
  const { ok, errors } = validatePrBody({ body })
  return { name: 'pr-format', ok, summary: ok ? 'PR description conforms' : errors.join('; ') }
}

/**
 * The eval-regression check: score the candidate recall over `records` at the baseline's pinned time and
 * compare to its floors. Pure — returns the result AND the full diff (the diff is persisted alongside).
 *
 * @param records the (frozen fixture) corpus to score
 * @param baseline the frozen baseline
 * @returns the check result + the baseline↔candidate diff
 */
export function evalRegressionResult(
  { records, baseline }: { records: readonly CorpusRecord[]; baseline: RecallBaseline },
): { readonly result: GateCheckResult; readonly diff: RegressionDiff } {
  const candidate = scoreRecall({ records, nowMs: Date.parse(baseline.nowIso), k: baseline.k, halfLifeDays: baseline.halfLifeDays })
  const diff = compareToBaseline({ candidate, baseline })
  const summary = diff.ok
    ? `recall@${String(baseline.k)} overall ${pct({ ratio: candidate.overall })} ≥ floor ${pct({ ratio: baseline.overallFloor })}`
    : diff.failures.map((f) => `${f.scope} ${pct({ ratio: f.actual })} < floor ${pct({ ratio: f.floor })}`).join('; ')
  return { result: { name: 'eval-regression', ok: diff.ok, summary }, diff }
}

/**
 * Compose the final verdict from the per-check results. `ok` iff every check passed; exit 0 or 1. Pure.
 *
 * @param results the per-check results
 * @returns the overall pass/fail + the process exit code
 */
export function composeGate({ results }: { results: readonly GateCheckResult[] }): { readonly ok: boolean; readonly exit: number } {
  const ok = results.every((r) => r.ok)
  return { ok, exit: ok ? 0 : 1 }
}

/**
 * Build the append-only JSONL run-log lines (one per check). Pure — `runId`/`tsIso` are injected so this
 * is deterministic and testable.
 *
 * @param runId the run id
 * @param tsIso the run timestamp
 * @param results the per-check results
 * @returns one JSON string per check
 */
export function gateLogLines(
  { runId, tsIso, results }: { runId: string; tsIso: string; results: readonly GateCheckResult[] },
): readonly string[] {
  return results.map((r) => JSON.stringify({ schemaVersion: 1, runId, tsIso, check: r.name, status: r.ok ? 'pass' : 'fail', summary: r.summary }))
}

/** Read a string flag from tokenised values (absent/boolean ⇒ undefined). */
function flagValue({ values, key }: { values: Readonly<Record<string, string | boolean>>; key: string }): string | undefined {
  const value = values[key]
  return typeof value === 'string' ? value : undefined
}

/** Read the PR body from a `--pr-body-file` path (wins) or `$PR_BODY`; undefined when neither is usable. */
function readPrBody({ bodyFile }: { bodyFile: string | undefined }): string | undefined {
  if (bodyFile !== undefined) {
    try {
      return readFileSync(bodyFile, 'utf8')
    } catch {
      return undefined
    }
  }
  return process.env.PR_BODY
}

/**
 * Run the whole gate: the three checks, the compose, and the ledger writes. The effectful shell over the
 * pure evaluators above.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code (0 all-clear, 1 any failure)
 */
export function runDevGate(argv: readonly string[]): number {
  // Positionals allowed (and ignored) so the `dev gate` verb token in the tail doesn't trip parsing.
  const parsed = parseFlags({ args: argv.slice(3), spec: { string: ['home', 'pr-body-file'] }, allowPositionals: true })
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => { process.stderr.write(`dev gate: ${e}\n`) })
    process.stderr.write('usage: slopweaver dev gate [--home <dir>] [--pr-body-file <path>]\n')
    return EXIT_USAGE
  }
  const { values } = parsed.value
  const home = flagValue({ values, key: 'home' })
  const paths = stateHomePaths(home !== undefined ? { home } : {})

  // 1) hygiene — the real repo scan (reads the private denylist from $SLOPWEAVER_HOME). Prints its own hits.
  const hygieneCode = runScan()
  const hygiene: GateCheckResult = { name: 'hygiene', ok: hygieneCode === 0, summary: hygieneCode === 0 ? 'clean' : 'leak-class/denylist hit(s) — see above' }

  // 2) eval-regression — deterministic recall over the frozen fixture vs the frozen baseline.
  const { result: evalResult, diff } = evalRegressionResult({ records: loadFixtureRecords({ path: fixturePath() }), baseline: loadBaseline() })

  // 3) pr-format — the description schema.
  const prFormat = prFormatResult({ body: readPrBody({ bodyFile: flagValue({ values, key: 'pr-body-file' }) }) })

  const results = [hygiene, prFormat, evalResult]
  const runId = randomUUID()
  const tsIso = new Date().toISOString()

  mkdirSync(paths.ledgers, { recursive: true })
  writeFileSync(join(paths.ledgers, 'dev-gate.jsonl'), `${gateLogLines({ runId, tsIso, results }).join('\n')}\n`, { flag: 'a' })
  writeFileSync(join(paths.ledgers, 'eval-regression.diff.json'), `${JSON.stringify(diff, null, 2)}\n`, 'utf8')

  process.stdout.write('\ndev gate:\n')
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? '✓' : '✗'} ${r.name}: ${r.summary}\n`)
  }
  const { ok, exit } = composeGate({ results })
  process.stdout.write(ok ? 'dev gate: PASS\n' : 'dev gate: FAIL\n')
  process.stdout.write(`(run log: ${join(paths.ledgers, 'dev-gate.jsonl')})\n`)
  return exit
}
