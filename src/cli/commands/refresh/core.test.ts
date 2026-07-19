import { describe, expect, it } from "vitest";
import { unwrap, unwrapErr } from "../../../lib/result.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK } from "../../exitCodes.js";
import {
  buildRefreshWindows,
  collectRepeated,
  missingTokenDiagnostics,
  parseRefreshOptions,
  type RefreshResult,
  refreshExitCode,
  refreshWindowLogLine,
  selectRefreshSources,
  summariseRefreshResults,
} from "./core.js";

const result = (over: Partial<RefreshResult>): RefreshResult => ({
  deduped: 0,
  errors: [],
  ok: true,
  projected: 0,
  source: "github",
  warnings: [],
  written: 0,
  ...over,
});

describe("collectRepeated", () => {
  it("collects every occurrence and leaves the rest", () => {
    const out = collectRepeated({ flag: "--source", rest: ["--source", "slack", "--all", "--source", "linear"] });
    expect(out.values).toEqual(["slack", "linear"]);
    expect(out.rest).toEqual(["--all"]);
  });

  it("does not consume a flag-shaped value", () => {
    const out = collectRepeated({ flag: "--source", rest: ["--source", "--all"] });
    expect(out.values).toEqual([]);
    expect(out.rest).toEqual(["--source", "--all"]);
  });
});

describe("parseRefreshOptions", () => {
  it("parses repeated sources and channels preserving order", () => {
    const parsed = parseRefreshOptions({
      rest: ["--source", "slack", "--source", "github", "--slack-channel", "C1", "--slack-channel", "C2"],
    });
    expect(parsed.ok).toBe(true);
    expect(unwrap(parsed).sources).toEqual(["slack", "github"]);
    expect(unwrap(parsed).slackChannels).toEqual(["C1", "C2"]);
  });

  it("defaults booleans off and omits absent values", () => {
    const parsed = parseRefreshOptions({ rest: [] });
    expect(unwrap(parsed).allSources).toBe(false);
    expect(unwrap(parsed).all).toBe(false);
    expect(unwrap(parsed).repo).toBeUndefined();
  });

  it("rejects a non-positive --lookback-days", () => {
    const parsed = parseRefreshOptions({ rest: ["--lookback-days", "0"] });
    expect(parsed.ok).toBe(false);
    expect(unwrapErr(parsed)[0]).toContain("--lookback-days");
  });
});

describe("selectRefreshSources", () => {
  it("defaults to github-only when nothing is chosen", () => {
    expect(unwrap(selectRefreshSources({ allSources: false, sources: [] }))).toEqual(["github"]);
  });

  it("returns all fetchable sources for --all-sources", () => {
    expect(unwrap(selectRefreshSources({ allSources: true, sources: [] }))).toEqual([
      "github",
      "slack",
      "linear",
      "notion",
    ]);
  });

  it("dedups repeated sources preserving first-seen order", () => {
    expect(unwrap(selectRefreshSources({ allSources: false, sources: ["slack", "github", "slack"] }))).toEqual([
      "slack",
      "github",
    ]);
  });

  it("rejects an unknown source", () => {
    const chosen = selectRefreshSources({ allSources: false, sources: ["jira"] });
    expect(chosen.ok).toBe(false);
    expect(unwrapErr(chosen)[0]).toContain("unknown --source: jira");
  });
});

describe("buildRefreshWindows", () => {
  const readNone = (): undefined => undefined;

  it("uses the GitHub 7-day default and non-GitHub 90-day default", () => {
    const windows = buildRefreshWindows({
      all: false,
      home: "/h",
      lookbackDays: undefined,
      readWatermark: readNone,
      sinceFlag: undefined,
      sources: ["github", "slack"],
      until: "2026-07-20",
    });
    expect(windows[0]).toEqual({ source: "github", window: { since: "2026-07-13", until: "2026-07-20" } });
    expect(windows[1]).toEqual({ source: "slack", window: { since: "2026-04-21", until: "2026-07-20" } });
  });

  it("uses the epoch since for --all", () => {
    const windows = buildRefreshWindows({
      all: true,
      home: "/h",
      lookbackDays: undefined,
      readWatermark: readNone,
      sinceFlag: undefined,
      sources: ["github"],
      until: "2026-07-20",
    });
    expect(windows[0]!.window.since).toBe("1970-01-01");
  });

  it("lets an explicit --since win over the watermark", () => {
    const windows = buildRefreshWindows({
      all: false,
      home: "/h",
      lookbackDays: undefined,
      readWatermark: () => "2020-01-01T00:00:00Z",
      sinceFlag: "2026-06-01",
      sources: ["github"],
      until: "2026-07-20",
    });
    expect(windows[0]!.window.since).toBe("2026-06-01");
  });

  it("uses the watermark cursor when there is no --since", () => {
    const windows = buildRefreshWindows({
      all: false,
      home: "/h",
      lookbackDays: undefined,
      readWatermark: () => "2026-05-05T12:00:00Z",
      sinceFlag: undefined,
      sources: ["github"],
      until: "2026-07-20",
    });
    expect(windows[0]!.window.since).toBe("2026-05-05");
  });
});

describe("missingTokenDiagnostics", () => {
  it("reports every requested non-GitHub source without a token", () => {
    const errors = missingTokenDiagnostics({
      selectedSources: ["github", "slack", "linear", "notion"],
      tokens: { linear: undefined, notion: "n", slack: undefined },
    });
    expect(errors).toEqual([
      "refresh: slack requested but no token (set SLACK_USER_TOKEN (or SLACK_BOT_TOKEN) or $SLOPWEAVER_HOME/secrets/slack-user-token)",
      "refresh: linear requested but no token (set LINEAR_TOKEN or $SLOPWEAVER_HOME/secrets/linear-token)",
    ]);
  });

  it("is empty when every requested source has a token (github never needs one)", () => {
    expect(missingTokenDiagnostics({ selectedSources: ["github"], tokens: {} })).toEqual([]);
  });
});

describe("refreshWindowLogLine", () => {
  it("clamps the shown end back to today (never the future)", () => {
    const line = refreshWindowLogLine({
      source: "github",
      today: "2026-07-19",
      window: { since: "2026-07-12", until: "2026-07-20" },
    });
    expect(line).toBe("refresh github · window 2026-07-12..2026-07-19");
  });

  it("shows the window end when it precedes today", () => {
    const line = refreshWindowLogLine({
      source: "slack",
      today: "2026-07-19",
      window: { since: "2026-01-01", until: "2026-05-01" },
    });
    expect(line).toBe("refresh slack · window 2026-01-01..2026-05-01");
  });
});

describe("summariseRefreshResults", () => {
  it("emits warnings, the wrote-line, and the trailing bronze path in order", () => {
    const summary = summariseRefreshResults({
      bronzePath: "/h/bronze",
      results: [result({ deduped: 2, projected: 5, source: "github", warnings: ["heads up"], written: 3 })],
    });
    expect(summary.lines).toEqual([
      { level: "warn", text: "  github: heads up" },
      { level: "out", text: "github: wrote 3 new, deduped 2 (from 5 projected)" },
      { level: "out", text: "→ /h/bronze" },
    ]);
    expect(summary.totalWritten).toBe(3);
    expect(summary.anyFailed).toBe(false);
  });

  it("marks a failed source and emits its errors instead of a wrote-line", () => {
    const summary = summariseRefreshResults({
      bronzePath: "/h/bronze",
      results: [result({ errors: ["boom"], ok: false, source: "slack" })],
    });
    expect(summary.anyFailed).toBe(true);
    expect(summary.totalWritten).toBe(0);
    expect(summary.lines).toEqual([
      { level: "error", text: "  slack: boom" },
      { level: "out", text: "→ /h/bronze" },
    ]);
  });
});

describe("refreshExitCode", () => {
  it("is error when any source failed", () => {
    expect(refreshExitCode({ anyFailed: true, totalWritten: 9 })).toBe(EXIT_ERROR);
  });

  it("is expected-empty when nothing was written", () => {
    expect(refreshExitCode({ anyFailed: false, totalWritten: 0 })).toBe(EXIT_EXPECTED_EMPTY);
  });

  it("is OK when records were written", () => {
    expect(refreshExitCode({ anyFailed: false, totalWritten: 4 })).toBe(EXIT_OK);
  });
});
