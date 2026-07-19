/**
 * The coverage-floor ratchet — the third PR3.7 ratchet, turning "green unit tests" into "the branches are
 * actually exercised". It reads Vitest's V8 `coverage/coverage-summary.json` and compares the four total
 * metrics against a committed `coverage/baseline.json` floor; the build fails if any metric drops. The
 * floor only moves UP, and only via an explicit `--rebaseline`, so it ratchets without ever silently
 * lowering the bar.
 *
 * Pure cores ({@link parseCoverageSummary}, {@link parseBaselineJson}, {@link compareCoverage},
 * {@link rebaselinePlan}) carry all the logic and are unit-tested; the thin {@link runCoverageRatchet} edge
 * reads/writes files and prints. It NEVER invokes Vitest — coverage is produced by `yarn test:coverage`
 * beforehand, so this stays cheap and non-blocking (a blocking check in `dev lint` is an automatic fail).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { parseJson } from "../lib/jsonParse.js";
import { err, ok, type Result } from "../lib/result.js";

/** The four coverage metrics the floor tracks, as rounded percentages. */
export interface CoverageMetrics {
  readonly branches: number;
  readonly functions: number;
  readonly lines: number;
  readonly statements: number;
}

/** The committed floor: a version tag plus the minimum acceptable percentages. */
export interface CoverageBaseline {
  readonly version: number;
  readonly summary: CoverageMetrics;
}

/** The metric keys, in report order. */
export const COVERAGE_METRIC_KEYS = ["branches", "functions", "lines", "statements"] as const;

const pctSchema = z.object({ pct: z.number() });
const summarySchema = z.object({
  total: z.object({ branches: pctSchema, functions: pctSchema, lines: pctSchema, statements: pctSchema }),
});
const metricsSchema = z.object({
  branches: z.number(),
  functions: z.number(),
  lines: z.number(),
  statements: z.number(),
});
const baselineSchema = z.object({ summary: metricsSchema, version: z.number() });

/** Round to two decimals — the baseline's granularity, so float noise can never flake the gate. Pure. */
export function round2({ value }: { value: number }): number {
  return Math.round(value * 100) / 100;
}

/**
 * Extract the four rounded total percentages from a V8 `coverage-summary.json`. Pure — a malformed summary
 * is a typed error, never a throw.
 *
 * @param text the summary file text
 * @returns the rounded metrics, or an error string
 */
export function parseCoverageSummary({ text }: { text: string }): Result<CoverageMetrics> {
  const parsed = parseJson({ text });
  if (parsed.isErr()) {
    return err([`coverage summary: ${parsed.error}`]);
  }
  const decoded = summarySchema.safeParse(parsed.value);
  if (!decoded.success) {
    return err(["coverage summary: unexpected shape (expected total.{branches,functions,lines,statements}.pct)"]);
  }
  const { total } = decoded.data;
  return ok({
    branches: round2({ value: total.branches.pct }),
    functions: round2({ value: total.functions.pct }),
    lines: round2({ value: total.lines.pct }),
    statements: round2({ value: total.statements.pct }),
  });
}

/**
 * Decode a committed baseline file. Pure.
 *
 * @param text the baseline file text
 * @returns the baseline, or an error string
 */
export function parseBaselineJson({ text }: { text: string }): Result<CoverageBaseline> {
  const parsed = parseJson({ text });
  if (parsed.isErr()) {
    return err([`coverage baseline: ${parsed.error}`]);
  }
  const decoded = baselineSchema.safeParse(parsed.value);
  if (!decoded.success) {
    return err([
      "coverage baseline: unexpected shape (expected version + summary.{branches,functions,lines,statements})",
    ]);
  }
  return ok({ summary: decoded.data.summary, version: decoded.data.version });
}

/**
 * Compare current coverage against the floor. Pure — equal or higher passes; any metric below its floor
 * (compared at two-decimal granularity) fails, listing each shortfall.
 *
 * @param current the measured metrics
 * @param baseline the committed floor
 * @returns pass/fail plus one failure line per dropped metric
 */
export function compareCoverage({ current, baseline }: { current: CoverageMetrics; baseline: CoverageMetrics }): {
  readonly ok: boolean;
  readonly failures: readonly string[];
} {
  const failures: string[] = [];
  for (const key of COVERAGE_METRIC_KEYS) {
    if (round2({ value: current[key] }) < round2({ value: baseline[key] })) {
      failures.push(`${key}: ${String(current[key])}% < floor ${String(baseline[key])}%`);
    }
  }
  return { failures, ok: failures.length === 0 };
}

/**
 * The rebaseline plan: a new baseline is allowed ONLY when every current metric is at/above the committed
 * floor (the floor never drops in PR3.7 — there is no `--allow-lower`). Pure.
 *
 * @param current the measured metrics
 * @param baseline the committed baseline
 * @returns the new baseline to write, or the metrics that would have lowered the floor
 */
export function rebaselinePlan({
  current,
  baseline,
}: {
  current: CoverageMetrics;
  baseline: CoverageBaseline;
}): Result<CoverageBaseline> {
  const lowered = COVERAGE_METRIC_KEYS.filter(
    (key) => round2({ value: current[key] }) < round2({ value: baseline.summary[key] }),
  );
  if (lowered.length > 0) {
    return err([`rebaseline refused — would lower: ${lowered.join(", ")}`]);
  }
  return ok({
    summary: {
      branches: round2({ value: current.branches }),
      functions: round2({ value: current.functions }),
      lines: round2({ value: current.lines }),
      statements: round2({ value: current.statements }),
    },
    version: baseline.version,
  });
}

/** Read a file, or `undefined` if it is absent/unreadable. */
function readFileOrUndefined({ path }: { path: string }): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The `--rebaseline` branch: write a raised floor, or refuse to lower it. Prints; returns the exit code. */
function applyRebaseline({
  baselinePath,
  current,
  baseline,
}: {
  baselinePath: string;
  current: CoverageMetrics;
  baseline: CoverageBaseline;
}): number {
  const plan = rebaselinePlan({ baseline, current });
  if (plan.ok === false) {
    process.stderr.write(`coverage-ratchet: ${plan.errors.join("; ")}\n`);
    return 1;
  }
  writeFileSync(baselinePath, `${JSON.stringify(plan.value, null, 2)}\n`);
  process.stdout.write(`coverage-ratchet: baseline rebaselined to ${JSON.stringify(plan.value.summary)}\n`);
  return 0;
}

/** The compare branch: pass, or print each metric that fell below its floor. Returns the exit code. */
function reportComparison({ current, baseline }: { current: CoverageMetrics; baseline: CoverageBaseline }): number {
  const verdict = compareCoverage({ baseline: baseline.summary, current });
  if (verdict.ok) {
    process.stdout.write(`coverage-ratchet: clean (floor ${JSON.stringify(baseline.summary)})\n`);
    return 0;
  }
  process.stderr.write("coverage-ratchet: coverage dropped below the committed floor:\n");
  for (const failure of verdict.failures) {
    process.stderr.write(`  ${failure}\n`);
  }
  process.stderr.write("raise tests or (deliberately) run `yarn coverage:rebaseline`.\n");
  return 1;
}

/**
 * The effectful edge: read the summary + baseline, then compare (or rebaseline). Prints diagnostics and
 * returns the process exit code. In `--summary-only` mode (used by `dev lint`, which runs BEFORE
 * `test:coverage` in `validate`) a MISSING summary is a lenient pass — the authoritative enforcement is the
 * standalone `yarn coverage:ratchet` that runs after coverage is generated.
 *
 * @param argv the process argv (flags `--rebaseline`, `--summary-only` read from index 2)
 * @returns the exit code (0 clean, 1 a drop / refused rebaseline / missing input)
 */
export function runCoverageRatchet(argv: readonly string[]): number {
  const flags = new Set(argv.slice(2));
  const summaryOnly = flags.has("--summary-only");
  const rebaseline = flags.has("--rebaseline");

  // Anchor on cwd, NOT git: yarn scripts + vitest both run from the package root, and vitest writes
  // `coverage/` cwd-relative — so cwd keeps the summary + baseline paths aligned even inside a git hook
  // (where GIT_DIR is set and `git rev-parse --show-toplevel` can resolve a different root).
  const root = process.cwd();
  const summaryPath = join(root, "coverage", "coverage-summary.json");
  // The floor lives OUTSIDE coverage/ — vitest wipes that dir on every `test:coverage` run.
  const baselinePath = join(root, "coverage-baseline.json");

  const summaryText = readFileOrUndefined({ path: summaryPath });
  if (summaryText === undefined) {
    if (summaryOnly) {
      process.stdout.write("coverage-ratchet: no coverage summary yet (run `yarn test:coverage`); skipped in lint\n");
      return 0;
    }
    process.stderr.write("coverage-ratchet: coverage summary missing; run `yarn test:coverage` first\n");
    return 1;
  }
  const baselineText = readFileOrUndefined({ path: baselinePath });
  if (baselineText === undefined) {
    process.stderr.write(`coverage-ratchet: baseline missing at ${baselinePath}\n`);
    return 1;
  }

  const currentResult = parseCoverageSummary({ text: summaryText });
  const baselineResult = parseBaselineJson({ text: baselineText });
  if (currentResult.ok === false) {
    process.stderr.write(`coverage-ratchet: ${currentResult.errors.join("; ")}\n`);
    return 1;
  }
  if (baselineResult.ok === false) {
    process.stderr.write(`coverage-ratchet: ${baselineResult.errors.join("; ")}\n`);
    return 1;
  }
  const current = currentResult.value;
  const baseline = baselineResult.value;

  return rebaseline ? applyRebaseline({ baseline, baselinePath, current }) : reportComparison({ baseline, current });
}
