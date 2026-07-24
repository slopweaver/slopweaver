/**
 * The PURE decision core of the `/slopweaver:onboard` slash command. The command itself is Claude-driven
 * (the chat IS the wizard — no blocking TTY verb), but its BRANCHING is deterministic logic that belongs in
 * testable TypeScript, not in prose: how a backfill choice threads to the exact `refresh` flags, and what a
 * re-run should skip vs redo given the current state (`doctor --json` + the four `connect --check` reports).
 * The markdown reads these decisions and runs the exact commands they name.
 *
 * Pure: no I/O, no clock. Every function is total and unit-tested with fixtures.
 */
import type { ConnectCheckReport, ConnectSource } from "../connect/types.js";
import { err, ok, type Result } from "../lib/result.js";

/** The chosen backfill depth: a rolling lookback window, an explicit start date, or the full history. */
export type BackfillChoice =
  | { readonly kind: "days"; readonly days: number }
  | { readonly kind: "since"; readonly since: string }
  | { readonly kind: "all" };

/** The default backfill: ~3 months, matching the NORTH-STAR acid test ("pull ~3 months across all tools"). */
export const DEFAULT_BACKFILL_DAYS = 90;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse a raw backfill answer: `all` ⇒ full history; a `YYYY-MM-DD` ⇒ an explicit `--since` start; a
 * positive integer ⇒ a rolling `--lookback-days` window. Pure — anything else is an error.
 *
 * @param value the raw answer (e.g. `90`, `all`, `2026-04-01`)
 * @returns the typed choice, or an error
 */
export function parseBackfillChoice({ value }: { value: string }): Result<BackfillChoice> {
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "all") {
    return ok({ kind: "all" });
  }
  if (ISO_DATE.test(trimmed)) {
    return ok({ kind: "since", since: trimmed });
  }
  const days = Number(trimmed);
  if (Number.isInteger(days) && days > 0) {
    return ok({ days, kind: "days" });
  }
  return err([`unrecognised backfill: ${value} (expected a day count, a YYYY-MM-DD date, or "all")`]);
}

/** The backfill choice as the `refresh` window flags. Pure. */
function backfillFlags({ backfill }: { backfill: BackfillChoice }): readonly string[] {
  if (backfill.kind === "all") {
    return ["--all"];
  }
  if (backfill.kind === "since") {
    return ["--since", backfill.since];
  }
  return ["--lookback-days", String(backfill.days)];
}

/**
 * Build the exact `slopweaver refresh` argument list for the full multi-source, all-org-repos backfill the
 * onboarding flow runs — GitHub org mode + Slack/Linear/Notion, over the chosen window. Pure.
 *
 * @param repo the `owner/repo` anchor
 * @param org the GitHub org (repo owner unless overridden)
 * @param backfill the chosen depth
 * @returns the argv tail beginning with `refresh`
 */
export function buildRefreshCommand({
  repo,
  org,
  backfill,
}: {
  repo: string;
  org: string;
  backfill: BackfillChoice;
}): readonly string[] {
  return [
    "refresh",
    "--all-sources",
    "--all-repos",
    "--repo",
    repo,
    "--github-org",
    org,
    ...backfillFlags({ backfill }),
  ];
}

/** What a (re-)run of onboarding still needs to do, derived from existing state — no ledger. */
export interface OnboardingResume {
  /** Whether `$SLOPWEAVER_HOME` still needs `init` (no home-version marker). */
  readonly needsInit: boolean;
  /** Sources whose token + scopes are already good — onboarding SKIPS their token setup. */
  readonly ready: readonly ConnectSource[];
  /** Sources still failing a `connect --check` — onboarding (re-)does their token/scope setup. */
  readonly blocked: readonly ConnectSource[];
}

/**
 * Derive what onboarding still needs to do from the current state: the `doctor --json` initialised flag and
 * the four `connect --check` reports. Ready sources (a passing check) are skipped on a re-run; blocked ones
 * are (re-)set up. This is the resumability signal — read from real state, never a bespoke onboarding
 * ledger, so re-running never double-does completed work. Pure.
 *
 * @param initialised whether `doctor --json` reports the home initialised
 * @param reports the per-source connect reports gathered this run
 * @returns the resume plan
 */
export function onboardingResumeStatus({
  initialised,
  reports,
}: {
  initialised: boolean;
  reports: readonly ConnectCheckReport[];
}): OnboardingResume {
  return {
    blocked: reports.filter((r) => !r.ok).map((r) => r.source),
    needsInit: !initialised,
    ready: reports.filter((r) => r.ok).map((r) => r.source),
  };
}
