/**
 * Re-baseline: the ONE authorised way the recall floors move. The `dev gate` never writes the baseline;
 * only this command does, and only under an explicit, deliberate invocation:
 *
 *   yarn eval:rebaseline --write --reason "why the floor is changing"
 *
 * It refuses without `--write`, refuses without a non-empty `--reason`, and refuses to run in CI unless
 * `SLOPWEAVER_ALLOW_REBASELINE_IN_CI=1` is also set — so a green build can never silently move its own
 * goalposts. It re-scores the frozen fixture and writes `eval/baseline.recall.json` (the deterministic
 * machine baseline only; the semantic scoreboard in docs/eval-baseline.md is owned by `yarn eval:scoreboard`).
 */
import { writeFileSync } from "node:fs";

import { err, ok, type Result } from "../lib/result.js";
import {
  baselinePath,
  buildBaseline,
  fixturePath,
  loadFixtureRecords,
  REGRESSION_NOW_ISO,
  scoreRecall,
} from "./regression.js";

/** The validated intent to move the baseline. */
export interface RebaselineDecision {
  readonly reason: string;
}

/**
 * Decide whether a rebaseline is authorised, purely from the flags + the two env signals (injected as
 * booleans, so this is testable without touching `process.env`). No I/O.
 *
 * @param args the CLI flag tail (e.g. `['--write', '--reason', 'text']`)
 * @param ci whether this is a CI environment
 * @param allowInCi whether the explicit CI override is set
 * @returns the decision, or an error explaining what is missing
 */
export function decideRebaseline({
  args,
  ci,
  allowInCi,
}: {
  args: readonly string[];
  ci: boolean;
  allowInCi: boolean;
}): Result<RebaselineDecision> {
  if (!args.includes("--write")) {
    return err(["refusing to move the baseline: pass --write to confirm (this is deliberate, not automatic)."]);
  }
  const reasonIndex = args.indexOf("--reason");
  const reason = reasonIndex === -1 ? undefined : args[reasonIndex + 1];
  if (reason === undefined || reason.trim().length === 0 || reason.startsWith("-")) {
    return err(['refusing to move the baseline: pass --reason "why the floor is changing".']);
  }
  if (ci && !allowInCi) {
    return err([
      "refusing to re-baseline in CI. Re-baseline locally and commit, or set SLOPWEAVER_ALLOW_REBASELINE_IN_CI=1 to override.",
    ]);
  }
  return ok({ reason: reason.trim() });
}

/** Truthy-env test for the `CI` / override flags (`'1'`, `'true'`, or merely present-non-empty). */
function envFlag({ value }: { value: string | undefined }): boolean {
  return value !== undefined && value.trim().length > 0 && value !== "0" && value.toLowerCase() !== "false";
}

/**
 * Effectful entry: validate authorisation, re-score the fixture, write the baseline.
 *
 * @param argv the full process argv
 * @returns the process exit code (0 written, 1 refused)
 */
export function runRebaseline(argv: readonly string[]): number {
  const decision = decideRebaseline({
    allowInCi: envFlag({ value: process.env["SLOPWEAVER_ALLOW_REBASELINE_IN_CI"] }),
    args: argv.slice(2),
    ci: envFlag({ value: process.env["CI"] }),
  });
  if (decision.ok === false) {
    decision.errors.forEach((e) => {
      process.stderr.write(`rebaseline: ${e}\n`);
    });
    return 1;
  }
  const records = loadFixtureRecords({ path: fixturePath() });
  const score = scoreRecall({ nowMs: Date.parse(REGRESSION_NOW_ISO), records });
  const baseline = buildBaseline({ reason: decision.value.reason, score });
  writeFileSync(baselinePath(), `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
  process.stderr.write(
    `rebaseline: wrote ${baselinePath()} — overall recall@${String(baseline.k)} floor ${(baseline.overallFloor * 100).toFixed(1)}% (reason: ${baseline.reason})\n`,
  );
  return 0;
}
