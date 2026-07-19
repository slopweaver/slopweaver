/**
 * The `dev lint` verb — the repo's whole static-analysis bar behind one door, so package.json keeps a
 * handful of scripts instead of a dozen. It runs EVERY check (no short-circuit — one run tells you
 * everything that's wrong), then exits non-zero if any failed:
 *
 *   biome (format + import order + bug rules) · prettier (docs) · oxlint (syntactic bug rules) ·
 *   eslint (type-aware rules + house rules) · knip (dead code) · yarn constraints (dep pins) ·
 *   hygiene (public leak gate) · door-coverage (admit-seam ratchet).
 *
 * Pure core / effectful shell: `lintChecks` (the plan) and `composeLint` (the verdict) are pure and
 * unit-tested; `runDevLint` is the thin edge that spawns each tool with inherited stdio.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { EXIT_OK } from "../cli/exitCodes.js";

/** One static-analysis check: its label plus the exact command to spawn. */
export interface LintCheck {
  readonly name: string;
  readonly cmd: string;
  readonly args: readonly string[];
}

/** One check's outcome. */
export interface LintCheckResult {
  readonly name: string;
  readonly ok: boolean;
}

/**
 * The ordered list of checks `dev lint` runs, resolved against a working directory (local JS bins live in
 * `node_modules/.bin`). Pure — takes the cwd so it stays testable.
 *
 * @param cwd the repo root the checks run from
 * @returns the checks in run order
 */
export function lintChecks({ cwd }: { cwd: string }): readonly LintCheck[] {
  const bin = (name: string): string => join(cwd, "node_modules", ".bin", name);
  return [
    // `--error-on-warnings`: Biome exits 0 on warn-level rules by default — this makes any warning fail the gate.
    { args: ["check", "--error-on-warnings", "."], cmd: bin("biome"), name: "biome" },
    { args: ["--check", "."], cmd: bin("prettier"), name: "prettier" },
    { args: ["--deny-warnings"], cmd: bin("oxlint"), name: "oxlint" },
    // `--max-warnings 0`: ESLint keeps archive-style advisory `warn` severities, but the gate fails on ANY
    // warning — zero-warning is enforced, never allowed to drift.
    { args: [".", "--max-warnings", "0"], cmd: bin("eslint"), name: "eslint" },
    { args: [], cmd: bin("knip"), name: "knip" },
    { args: ["constraints"], cmd: "yarn", name: "constraints" },
    { args: ["scripts/check-hygiene.sh"], cmd: "bash", name: "hygiene" },
    // Fails if a hand-rolled retry/backoff/rate-limiter is reintroduced after the PR3.5 librafication (D21).
    { args: ["src/devLint/resilienceResidue.entry.ts"], cmd: bin("tsx"), name: "resilience-residue" },
    // Fails if an external boundary (SDK/LLM/embed) is called outside a safe* wrapper (PR3.6 typed errors).
    { args: ["src/devLint/boundaryResidue.entry.ts"], cmd: bin("tsx"), name: "boundary-residue" },
    // Fails if a function body exceeds the per-function line ceiling (PR3.6 pure-core discipline).
    { args: ["src/devLint/maxFunctionLines.entry.ts"], cmd: bin("tsx"), name: "max-function-lines" },
    // Fails if coverage dropped below the committed floor (PR3.7). `--summary-only` never runs vitest and
    // is lenient when no summary exists yet (lint runs before test:coverage in validate); the hard gate is
    // the standalone `yarn coverage:ratchet` that validate runs after coverage is generated.
    { args: ["src/devLint/coverageRatchet.entry.ts", "--summary-only"], cmd: bin("tsx"), name: "coverage-ratchet" },
    { args: ["src/cli/index.ts", "dev", "door-coverage"], cmd: bin("tsx"), name: "door-coverage" },
  ];
}

/**
 * Compose the final verdict: `ok` iff every check passed. Pure.
 *
 * @param results the per-check outcomes
 * @returns the overall pass/fail + the process exit code (0 all-clear, 1 any failure)
 */
export function composeLint({ results }: { results: readonly LintCheckResult[] }): {
  readonly ok: boolean;
  readonly exit: number;
} {
  const ok = results.every((r) => r.ok);
  return { exit: ok ? 0 : 1, ok };
}

const USAGE = "usage: slopweaver dev lint";

/**
 * Run the whole lint bar. The effectful shell: spawn each check with inherited stdio (so every tool prints
 * its own diagnostics), then print a summary and return the composed exit code.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code (0 all-clear, 1 any check failed)
 */
export function runDevLint(argv: readonly string[]): number {
  const rest = new Set(argv.slice(3));
  if (rest.has("--help") || rest.has("-h")) {
    process.stdout.write(`${USAGE}\n`);
    return EXIT_OK;
  }
  const cwd = process.cwd();
  const results: LintCheckResult[] = [];
  for (const check of lintChecks({ cwd })) {
    process.stdout.write(`\ndev lint: ${check.name}\n`);
    const outcome = spawnSync(check.cmd, [...check.args], { cwd, stdio: "inherit" });
    results.push({ name: check.name, ok: outcome.status === 0 });
  }

  process.stdout.write("\ndev lint:\n");
  for (const r of results) {
    process.stdout.write(`  ${r.ok ? "✓" : "✗"} ${r.name}\n`);
  }
  const { ok, exit } = composeLint({ results });
  process.stdout.write(ok ? "dev lint: PASS\n" : "dev lint: FAIL\n");
  return exit;
}
