/**
 * The pure core of the `refresh` verb — flag parsing, source selection, per-source window planning, the
 * missing-token diagnostics, and the result summary + exit code — extracted from the old 126-line
 * (complexity-24) `runRefresh` so each concern is unit-tested apart from the token reads / connector
 * factories / ingest IO the shell ({@link ./run}) owns. Nothing here touches the network, env, or disk;
 * the watermark read is an injected seam so window planning stays pure.
 */
import type { CorpusSource, ExportWindow } from "../../../corpus/types.js";
import { resolveSince } from "../../../corpus/watermark.js";
import { yyyyMmDdMinusDays } from "../../../lib/date.js";
import { err, ok, type Result } from "../../../lib/result.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK } from "../../exitCodes.js";
import { parseFlagTail, parsePositiveInteger } from "../../optionParsers.js";

/** The non-GitHub connectors — the sources whose absence-of-token is a usage error. */
export type TokenedSource = "slack" | "linear" | "notion";

/** The sources `refresh` can fetch. */
export const FETCHABLE_SOURCES: readonly CorpusSource[] = ["github", "slack", "linear", "notion"];

const GITHUB_LOOKBACK_DAYS = 7;
const SOURCE_LOOKBACK_DAYS = 90;
const EPOCH_SINCE = "1970-01-01";

/** The validated `refresh` options (mirrors the verb's flags). */
export interface RefreshOptions {
  readonly sources: readonly string[];
  readonly slackChannels: readonly string[];
  readonly allSources: boolean;
  readonly all: boolean;
  readonly noEnrich: boolean;
  readonly repo?: string;
  readonly since?: string;
  readonly until?: string;
  readonly lookbackDays?: number;
  readonly home?: string;
}

/**
 * Collect every `--flag value` occurrence out of the tail, returning the values + the remaining tail. Pure.
 *
 * @param rest the argv tail
 * @param flag the repeatable flag to collect
 * @returns the collected values + the tail with them removed
 */
export function collectRepeated({ rest, flag }: { rest: readonly string[]; flag: string }): {
  readonly values: readonly string[];
  readonly rest: readonly string[];
} {
  const values: string[] = [];
  const remaining: string[] = [];
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    const next = rest[i + 1];
    if (token === flag && next !== undefined && !next.startsWith("-")) {
      values.push(next);
      i += 1;
      continue;
    }
    remaining.push(token);
  }
  return { rest: remaining, values };
}

/**
 * Parse + validate the `refresh` flag tail into typed options. Pure — a bad flag or a non-positive
 * `--lookback-days` yields an error Result, never a throw.
 *
 * @param rest the verb tail (argv from index 3)
 * @returns the validated options, or the accumulated flag errors
 */
export function parseRefreshOptions({ rest }: { rest: readonly string[] }): Result<RefreshOptions> {
  const afterSources = collectRepeated({ flag: "--source", rest });
  const afterChannels = collectRepeated({ flag: "--slack-channel", rest: afterSources.rest });
  const parsed = parseFlagTail({
    rest: afterChannels.rest,
    spec: { boolean: ["no-enrich", "all-sources", "all"], value: ["repo", "since", "until", "lookback-days", "home"] },
  });
  if (parsed.ok === false) {
    return err(parsed.errors);
  }
  const { values, flags } = parsed.value;
  const errors: string[] = [];
  const lookbackDays =
    values["lookback-days"] !== undefined
      ? parsePositiveInteger({ errors, label: "--lookback-days", value: values["lookback-days"] })
      : undefined;
  if (errors.length > 0) {
    return err(errors);
  }
  return ok({
    all: flags.has("all"),
    allSources: flags.has("all-sources"),
    noEnrich: flags.has("no-enrich"),
    slackChannels: afterChannels.values,
    sources: afterSources.values,
    ...(values["repo"] !== undefined ? { repo: values["repo"] } : {}),
    ...(values["since"] !== undefined ? { since: values["since"] } : {}),
    ...(values["until"] !== undefined ? { until: values["until"] } : {}),
    ...(lookbackDays !== undefined ? { lookbackDays } : {}),
    ...(values["home"] !== undefined ? { home: values["home"] } : {}),
  });
}

/**
 * Resolve the selected sources: `--all-sources` → all; else the `--source` list (deduped, first-seen
 * order); else GitHub-only. An unknown source is an error. Pure.
 *
 * @param sources the raw `--source` values
 * @param allSources whether `--all-sources` was set
 * @returns the resolved sources, or an unknown-source error
 */
export function selectRefreshSources({
  sources,
  allSources,
}: {
  sources: readonly string[];
  allSources: boolean;
}): Result<readonly CorpusSource[]> {
  if (allSources) {
    return ok(FETCHABLE_SOURCES);
  }
  if (sources.length === 0) {
    return ok(["github"]);
  }
  const invalid = sources.filter((source) => !FETCHABLE_SOURCES.includes(source as CorpusSource));
  if (invalid.length > 0) {
    return err([`unknown --source: ${invalid.join(", ")} (expected ${FETCHABLE_SOURCES.join("|")})`]);
  }
  const unique = [...new Set(sources)].filter((source): source is CorpusSource =>
    FETCHABLE_SOURCES.includes(source as CorpusSource),
  );
  return ok(unique);
}

/** One source's resolved ingest window. */
export interface RefreshWindow {
  readonly source: CorpusSource;
  readonly window: ExportWindow;
}

/**
 * Plan each source's window: the watermark cursor → `since`, else `--all`/`--since`/lookback fallback.
 * `lookbackDays` overrides the per-source default depth (GitHub 7 days, the rest 90). Pure via the injected
 * `readWatermark` seam.
 *
 * @param sources the selected sources
 * @param home the world-model home (passed to `readWatermark`)
 * @param sinceFlag the explicit `--since`, if any (wins over the watermark)
 * @param until the window's exclusive upper bound (`YYYY-MM-DD…`)
 * @param all whether `--all` was set (epoch since)
 * @param lookbackDays the `--lookback-days` override, if any
 * @param readWatermark the per-source cursor reader (injected)
 * @returns one window per source, in selection order
 */
export function buildRefreshWindows({
  sources,
  home,
  sinceFlag,
  until,
  all,
  lookbackDays,
  readWatermark,
}: {
  sources: readonly CorpusSource[];
  home: string;
  sinceFlag: string | undefined;
  until: string;
  all: boolean;
  lookbackDays: number | undefined;
  readWatermark: (args: { home: string; source: CorpusSource }) => string | undefined;
}): readonly RefreshWindow[] {
  return sources.map((source) => {
    const lookback = lookbackDays ?? (source === "github" ? GITHUB_LOOKBACK_DAYS : SOURCE_LOOKBACK_DAYS);
    const fallbackSince = all ? EPOCH_SINCE : yyyyMmDdMinusDays({ date: until.slice(0, 10), days: lookback });
    const since = sinceFlag ?? resolveSince({ cursor: readWatermark({ home, source }), fallbackSince });
    return { source, window: { since, until } };
  });
}

/** The env-var hint for a source with no configured token (Slack lists both of its token env vars). Pure. */
export function tokenHint({ source }: { source: TokenedSource }): string {
  return source === "slack"
    ? "set SLACK_USER_TOKEN (or SLACK_BOT_TOKEN) or $SLOPWEAVER_HOME/secrets/slack-user-token"
    : `set ${source.toUpperCase()}_TOKEN or $SLOPWEAVER_HOME/secrets/${source}-token`;
}

/**
 * The usage errors for every requested non-GitHub source that has no token — computed BEFORE any network
 * or write. Pure: token presence is resolved by the shell into `tokens` and passed in.
 *
 * @param selectedSources the resolved sources
 * @param tokens the resolved token (or `undefined`) per non-GitHub source
 * @returns one `refresh: <source> requested but no token …` line per missing token
 */
export function missingTokenDiagnostics({
  selectedSources,
  tokens,
}: {
  selectedSources: readonly CorpusSource[];
  tokens: Readonly<Partial<Record<TokenedSource, string | undefined>>>;
}): readonly string[] {
  return selectedSources
    .filter((source): source is TokenedSource => source !== "github")
    .filter((source) => tokens[source] === undefined)
    .map((source) => `refresh: ${source} requested but no token (${tokenHint({ source })})`);
}

/**
 * The per-source window log line. The internal `until` is today+1 (an exclusive upper bound); render the
 * actual inclusive end — never past `today` — so the line doesn't look like it's fetching the future. Pure.
 *
 * @param source the source
 * @param window its resolved window
 * @param today today as `YYYY-MM-DD` (the shell derives it from its clock)
 * @returns the log line
 */
export function refreshWindowLogLine({
  source,
  window,
  today,
}: {
  source: CorpusSource;
  window: ExportWindow;
  today: string;
}): string {
  const shownUntil = window.until < today ? window.until : today;
  return `refresh ${source} · window ${window.since}..${shownUntil}`;
}

/** One summary line, tagged with the stream it belongs on so the shell emits it verbatim in order. */
export interface RefreshSummaryLine {
  readonly level: "out" | "warn" | "error";
  readonly text: string;
}

/** The refresh summary: the ordered output/warn/error lines plus the totals that decide the exit code. */
export interface RefreshSummary {
  readonly lines: readonly RefreshSummaryLine[];
  readonly totalWritten: number;
  readonly anyFailed: boolean;
}

/** A per-source ingest result the summary reads (a structural subset of `SourceIngestResult`). */
export interface RefreshResult {
  readonly source: CorpusSource;
  readonly ok: boolean;
  readonly projected: number;
  readonly written: number;
  readonly deduped: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

/**
 * Summarise the ingest results into the exact ordered lines the shell prints (per-source warnings, then
 * errors or the wrote-line, then the trailing bronze-path line) plus the totals. Pure.
 *
 * @param results the per-source ingest results, in run order
 * @param bronzePath the bronze directory (the trailing `→ <path>` line)
 * @returns the ordered lines + totals
 */
export function summariseRefreshResults({
  results,
  bronzePath,
}: {
  results: readonly RefreshResult[];
  bronzePath: string;
}): RefreshSummary {
  const lines: RefreshSummaryLine[] = [];
  let totalWritten = 0;
  let anyFailed = false;
  for (const result of results) {
    for (const w of result.warnings) {
      lines.push({ level: "warn", text: `  ${result.source}: ${w}` });
    }
    if (result.ok === false) {
      anyFailed = true;
      for (const e of result.errors) {
        lines.push({ level: "error", text: `  ${result.source}: ${e}` });
      }
      continue;
    }
    totalWritten += result.written;
    lines.push({
      level: "out",
      text: `${result.source}: wrote ${String(result.written)} new, deduped ${String(result.deduped)} (from ${String(result.projected)} projected)`,
    });
  }
  lines.push({ level: "out", text: `→ ${bronzePath}` });
  return { anyFailed, lines, totalWritten };
}

/**
 * The refresh exit code: any source failed ⇒ error; nothing written ⇒ expected-empty; else OK. Pure.
 *
 * @param anyFailed whether any source failed
 * @param totalWritten total records written across sources
 * @returns the exit code
 */
export function refreshExitCode({ anyFailed, totalWritten }: { anyFailed: boolean; totalWritten: number }): number {
  if (anyFailed) {
    return EXIT_ERROR;
  }
  return totalWritten === 0 ? EXIT_EXPECTED_EMPTY : EXIT_OK;
}
