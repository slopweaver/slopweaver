import { describe, expect, it } from "vitest";
import { finaliseReport } from "../connect/types.js";
import { unwrap, unwrapErr } from "../lib/result.js";
import { buildRefreshCommand, DEFAULT_BACKFILL_DAYS, onboardingResumeStatus, parseBackfillChoice } from "./plan.js";

describe("parseBackfillChoice", () => {
  it("parses a day count into a rolling window", () => {
    expect(unwrap(parseBackfillChoice({ value: "30" }))).toEqual({ days: 30, kind: "days" });
    expect(unwrap(parseBackfillChoice({ value: "180" }))).toEqual({ days: 180, kind: "days" });
  });

  it("parses the default 90-day depth", () => {
    expect(unwrap(parseBackfillChoice({ value: String(DEFAULT_BACKFILL_DAYS) }))).toEqual({ days: 90, kind: "days" });
  });

  it("parses `all` into a full-history backfill", () => {
    expect(unwrap(parseBackfillChoice({ value: "all" }))).toEqual({ kind: "all" });
  });

  it("parses a YYYY-MM-DD into an explicit since", () => {
    expect(unwrap(parseBackfillChoice({ value: "2026-04-01" }))).toEqual({ kind: "since", since: "2026-04-01" });
  });

  it("rejects a nonsense value", () => {
    expect(unwrapErr(parseBackfillChoice({ value: "lots" }))[0]).toContain("unrecognised backfill");
  });
});

describe("buildRefreshCommand", () => {
  it("threads a day count to --lookback-days across all sources + all org repos", () => {
    expect(buildRefreshCommand({ backfill: { days: 90, kind: "days" }, org: "acme", repo: "acme/app" })).toEqual([
      "refresh",
      "--all-sources",
      "--all-repos",
      "--repo",
      "acme/app",
      "--github-org",
      "acme",
      "--lookback-days",
      "90",
    ]);
  });

  it("threads a full backfill to --all with NO --lookback-days", () => {
    const cmd = buildRefreshCommand({ backfill: { kind: "all" }, org: "acme", repo: "acme/app" });
    expect(cmd).toContain("--all");
    expect(cmd).not.toContain("--lookback-days");
  });

  it("threads an explicit since to --since YYYY-MM-DD", () => {
    const cmd = buildRefreshCommand({
      backfill: { kind: "since", since: "2026-04-01" },
      org: "acme",
      repo: "acme/app",
    });
    expect(cmd.slice(-2)).toEqual(["--since", "2026-04-01"]);
  });
});

describe("onboardingResumeStatus", () => {
  const ready = finaliseReport({
    capabilities: [{ detail: "ok", id: "auth", status: "ok" }],
    source: "slack",
    tokenPresent: true,
  });
  const blocked = finaliseReport({
    capabilities: [{ detail: "gap", id: "scope:read:org", status: "missing" }],
    source: "github",
    tokenPresent: true,
  });

  it("skips ready sources and re-does blocked ones, from real state (no ledger)", () => {
    const resume = onboardingResumeStatus({ initialised: true, reports: [ready, blocked] });
    expect(resume).toEqual({ blocked: ["github"], needsInit: false, ready: ["slack"] });
  });

  it("flags a home that still needs init", () => {
    expect(onboardingResumeStatus({ initialised: false, reports: [] }).needsInit).toBe(true);
  });
});
