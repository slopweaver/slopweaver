/**
 * `slopweaver refresh` — the bronze ingest across every source. Bare `refresh` stays GitHub-only for
 * back-compat; `--source <id>` (repeatable) and `--all-sources` select Slack/Linear/Notion/GitHub, each
 * fetched over its own incremental window (per-source watermark; `--since`/`--all` override depth,
 * default ~90 days for the new sources), projected into `CorpusRecord`s, and committed through the one
 * write+watermark path (`ingestSource`). A requested source with no token is a usage error before any
 * network. Derive/distil (silver/gold) are separate verbs; this one only fills bronze.
 */

import {
  githubToken,
  linearToken,
  notionToken,
  parseRepositorySlug,
  resolveRepository,
  slackBotToken,
  slackUserToken,
  slopweaverHome,
} from "../../../config.js";
import { bronzeDir } from "../../../corpus/corpusPaths.js";
import { githubFetchItems } from "../../../corpus/github/fetch.js";
import { projectGithubRecords } from "../../../corpus/github/project.js";
import { ingestSources, type SourceIngestJob } from "../../../corpus/ingestSource.js";
import { fetchLinearActivity, makeLinearApi } from "../../../corpus/linear/fetch.js";
import { projectLinearRecords } from "../../../corpus/linear/project.js";
import { fetchNotionActivity, makeNotionApi } from "../../../corpus/notion/fetch.js";
import { projectNotionRecords } from "../../../corpus/notion/project.js";
import { fetchSlackActivity, makeSlackApi, resolveSlackReadToken } from "../../../corpus/slack/fetch.js";
import { projectSlackRecords } from "../../../corpus/slack/project.js";
import { readThreadCursors, writeThreadCursors } from "../../../corpus/slack/threadCursors.js";
import type { CorpusRecord, CorpusSource, ExportWindow } from "../../../corpus/types.js";
import { readWatermark, resolveSince } from "../../../corpus/watermark.js";
import { logger } from "../../../lib/logger.js";
import { createProgressEmitter } from "../../../lib/progress.js";
import { err, ok, type Result } from "../../../lib/result.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_ERROR, EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { parseFlagTail, parsePositiveInteger } from "../../optionParsers.js";

const USAGE =
  "usage: slopweaver refresh [--repo owner/repo] [--source github|slack|linear|notion]... [--all-sources] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--all] [--slack-channel <id>]... [--lookback-days N] [--no-enrich]";

const GITHUB_LOOKBACK_DAYS = 7;
const SOURCE_LOOKBACK_DAYS = 90;
const EPOCH_SINCE = "1970-01-01";
const FETCHABLE: readonly CorpusSource[] = ["github", "slack", "linear", "notion"];

/** A UTC date `days` from today, as `YYYY-MM-DD`. */
function todayPlus({ days }: { days: number }): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** `days` before a `YYYY-MM-DD` date, as `YYYY-MM-DD`. */
function isoMinusDays({ untilDate, days }: { untilDate: string; days: number }): string {
  const date = new Date(`${untilDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** Collect every `--flag value` occurrence out of the tail, returning the values + the remaining tail. */
function collectRepeated({ rest, flag }: { rest: readonly string[]; flag: string }): {
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

/** Resolve the selected sources: `--all-sources` → all; else the `--source` list; else GitHub-only. */
function selectedSources({
  sources,
  allSources,
}: {
  sources: readonly string[];
  allSources: boolean;
}): Result<readonly CorpusSource[]> {
  if (allSources) {
    return ok(FETCHABLE);
  }
  if (sources.length === 0) {
    return ok(["github"]);
  }
  const invalid = sources.filter((source): boolean => !FETCHABLE.includes(source as CorpusSource));
  if (invalid.length > 0) {
    return err([`unknown --source: ${invalid.join(", ")} (expected ${FETCHABLE.join("|")})`]);
  }
  const unique = [...new Set(sources)].filter((source): source is CorpusSource =>
    FETCHABLE.includes(source as CorpusSource),
  );
  return ok(unique);
}

/** Compute a source's window: watermark cursor → `since`, or `--all`/`--since`/lookback fallback. `lookbackDays`
 * (the `--lookback-days` flag) overrides the per-source default depth when set. */
function windowFor({
  source,
  home,
  until,
  sinceFlag,
  all,
  lookbackDays,
}: {
  source: CorpusSource;
  home: string;
  until: string;
  sinceFlag: string | undefined;
  all: boolean;
  lookbackDays: number | undefined;
}): ExportWindow {
  const lookback = lookbackDays ?? (source === "github" ? GITHUB_LOOKBACK_DAYS : SOURCE_LOOKBACK_DAYS);
  const fallbackSince = all ? EPOCH_SINCE : isoMinusDays({ days: lookback, untilDate: until.slice(0, 10) });
  const since = sinceFlag ?? resolveSince({ cursor: readWatermark({ home, source }), fallbackSince });
  return { since, until };
}

/** Build the GitHub ingest job (unchanged discovery+enrichment behaviour, wrapped as a source job). */
function githubJob({
  repoSlug,
  window,
  noEnrich,
}: {
  repoSlug: string | undefined;
  window: ExportWindow;
  noEnrich: boolean;
}): Result<SourceIngestJob> {
  const repoResult = repoSlug !== undefined ? parseRepositorySlug({ slug: repoSlug }) : resolveRepository();
  if (repoResult.ok === false) {
    return repoResult;
  }
  const repo = repoResult.value;
  const token = githubToken();
  const enrich = !noEnrich && token !== undefined;
  if (token === undefined) {
    logger.warn("no GitHub auth (set GITHUB_TOKEN or run `gh auth login`) — discovery-only, no reviews/comments");
  }
  return ok({
    label: `${repo.owner}/${repo.repo}`,
    run: async (): Promise<Result<{ records: readonly CorpusRecord[]; warnings: readonly string[] }>> => {
      const fetched = await githubFetchItems({ enrich, ...(token !== undefined ? { token } : {}) })({ repo, window });
      if (fetched.ok === false) {
        return fetched;
      }
      return ok({
        records: projectGithubRecords({ items: fetched.value, repo: `${repo.owner}/${repo.repo}` }),
        warnings: fetched.warnings,
      });
    },
    source: "github",
    window,
  });
}

/** Build a Slack/Linear/Notion job from its token + window (token presence checked by the caller). */
function sourceJob({
  source,
  token,
  window,
  slackChannels,
  home,
}: {
  source: "slack" | "linear" | "notion";
  token: string;
  window: ExportWindow;
  slackChannels: readonly string[];
  home: string;
}): SourceIngestJob {
  const run = async (): Promise<Result<{ records: readonly CorpusRecord[]; warnings: readonly string[] }>> => {
    if (source === "slack") {
      // Incremental reply reads: read the per-thread cursors, fetch only new replies, persist the update.
      const fetched = await fetchSlackActivity({
        api: makeSlackApi({ token }),
        threadCursors: readThreadCursors({ home }),
        window,
        ...(slackChannels.length > 0 ? { channelFilter: slackChannels } : {}),
      });
      if (fetched.ok === false) {
        return fetched;
      }
      const stored = writeThreadCursors({ cursors: fetched.value.threadCursors, home });
      const warnings = stored.ok
        ? fetched.value.warnings
        : [...fetched.value.warnings, ...stored.errors.map((e) => `thread-cursor persist failed: ${e}`)];
      return ok({
        records: projectSlackRecords({ channels: fetched.value.channels, maps: fetched.value.maps }),
        warnings,
      });
    }
    if (source === "linear") {
      const fetched = await fetchLinearActivity({ api: makeLinearApi({ token }), window });
      return fetched.ok ? ok({ records: projectLinearRecords(fetched.value), warnings: [] }) : fetched;
    }
    const fetched = await fetchNotionActivity({ api: makeNotionApi({ token }), window });
    return fetched.ok
      ? ok({ records: projectNotionRecords(fetched.value), warnings: fetched.value.warnings })
      : fetched;
  };
  return { label: source, run, source, window };
}

/** The env/home token for Linear/Notion. Slack uses the two-token {@link slackReadToken} instead. */
function tokenFor({ source }: { source: "linear" | "notion" }): string | undefined {
  return source === "linear" ? linearToken() : notionToken();
}

/** The Slack READ token: a user token wins; a bot token is the fallback with a limited-visibility warning. */
function slackReadToken(): { token?: string; warning?: string } {
  return resolveSlackReadToken({ botToken: slackBotToken(), userToken: slackUserToken() });
}

/** Resolve a requested source's token (Slack read-token vs Linear/Notion), or undefined when unconfigured. */
function sourceToken({ source }: { source: "slack" | "linear" | "notion" }): string | undefined {
  return source === "slack" ? slackReadToken().token : tokenFor({ source });
}

/** The env-var hint for a source with no configured token (Slack lists both of its token env vars). */
function tokenHint({ source }: { source: "slack" | "linear" | "notion" }): string {
  return source === "slack"
    ? "set SLACK_USER_TOKEN (or SLACK_BOT_TOKEN) or $SLOPWEAVER_HOME/secrets/slack-user-token"
    : `set ${source.toUpperCase()}_TOKEN or $SLOPWEAVER_HOME/secrets/${source}-token`;
}

/**
 * Run the refresh verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runRefresh(argv: readonly string[]): Promise<number> {
  const rawRest = argv.slice(3);
  if (rawRest.includes("--help") || rawRest.includes("-h")) {
    logger.out(USAGE);
    return EXIT_OK;
  }
  const afterSources = collectRepeated({ flag: "--source", rest: rawRest });
  const afterChannels = collectRepeated({ flag: "--slack-channel", rest: afterSources.rest });
  const parsed = parseFlagTail({
    rest: afterChannels.rest,
    spec: { boolean: ["no-enrich", "all-sources", "all"], value: ["repo", "since", "until", "lookback-days", "home"] },
  });
  if (parsed.ok === false) {
    parsed.errors.forEach((e) => {
      logger.error(e);
    });
    logger.error(USAGE);
    return EXIT_USAGE;
  }
  const { values, flags } = parsed.value;
  const home = values["home"] ?? slopweaverHome();

  const chosen = selectedSources({ allSources: flags.has("all-sources"), sources: afterSources.values });
  if (chosen.ok === false) {
    chosen.errors.forEach((e) => {
      logger.error(e);
    });
    logger.error(USAGE);
    return EXIT_USAGE;
  }

  const flagErrors: string[] = [];
  const lookbackDays =
    values["lookback-days"] !== undefined
      ? parsePositiveInteger({ errors: flagErrors, label: "--lookback-days", value: values["lookback-days"] })
      : undefined;
  if (flagErrors.length > 0) {
    flagErrors.forEach((e) => {
      logger.error(e);
    });
    return EXIT_USAGE;
  }

  const until = values["until"] ?? todayPlus({ days: 1 });
  const sinceFlag = values["since"];
  const all = flags.has("all");

  // A requested non-GitHub source with no token is a usage error BEFORE any network/write.
  const missing = chosen.value
    .filter((source): source is "slack" | "linear" | "notion" => source !== "github")
    .filter((source) => sourceToken({ source }) === undefined);
  if (missing.length > 0) {
    missing.forEach((source) => {
      logger.error(`refresh: ${source} requested but no token (${tokenHint({ source })})`);
    });
    return EXIT_USAGE;
  }

  const jobs: SourceIngestJob[] = [];
  for (const source of chosen.value) {
    const window = windowFor({ all, home, lookbackDays, sinceFlag, source, until });
    if (source === "github") {
      const built = githubJob({ noEnrich: flags.has("no-enrich"), repoSlug: values["repo"], window });
      if (built.ok === false) {
        built.errors.forEach((e) => {
          logger.error(e);
        });
        return EXIT_USAGE;
      }
      jobs.push(built.value);
    } else if (source === "slack") {
      const read = slackReadToken(); // token presence validated above; warn if it's the bot-token fallback
      if (read.warning !== undefined) {
        logger.warn(read.warning);
      }
      jobs.push(sourceJob({ home, slackChannels: afterChannels.values, source, token: read.token!, window }));
    } else if (source === "linear" || source === "notion") {
      const token = tokenFor({ source })!; // presence validated above
      jobs.push(sourceJob({ home, slackChannels: afterChannels.values, source, token, window }));
    }
    // The internal `until` is today+1 (an exclusive upper bound for the search APIs); render the actual
    // inclusive end — never past today — so the line doesn't look like it's fetching the future.
    const today = todayPlus({ days: 0 });
    const shownUntil = window.until < today ? window.until : today;
    logger.info(`refresh ${source} · window ${window.since}..${shownUntil}`);
  }

  // Non-blocking, session-visible per-source progress across the (possibly long) multi-source ingest.
  const progress = createProgressEmitter({ verb: "refresh" });
  const outcome = await ingestSources({
    home,
    jobs,
    onProgress: (p) => {
      progress.update({
        counts: p.written !== undefined ? { written: p.written } : {},
        done: p.done,
        phase: `${p.phase}:${p.label}`,
        total: p.total,
      });
    },
  });
  const results = outcome.ok ? outcome.value : [];
  let totalWritten = 0;
  let anyFailed = false;
  for (const result of results) {
    result.warnings.forEach((w) => {
      logger.warn(`  ${result.source}: ${w}`);
    });
    if (result.ok === false) {
      anyFailed = true;
      result.errors.forEach((e) => {
        logger.error(`  ${result.source}: ${e}`);
      });
      continue;
    }
    totalWritten += result.written;
    logger.out(
      `${result.source}: wrote ${String(result.written)} new, deduped ${String(result.deduped)} (from ${String(result.projected)} projected)`,
    );
  }
  logger.out(`→ ${bronzeDir({ home })}`);
  if (anyFailed) {
    return EXIT_ERROR;
  }
  return totalWritten === 0 ? EXIT_EXPECTED_EMPTY : EXIT_OK;
}

export const refreshRunCommand = defineCommand({
  createsWorkItem: false,
  diagnostic: false,
  doorRouted: false,
  dryParseSafe: false,
  effect: "local-state",
  example: "slopweaver refresh --all-sources --since 2026-04-01",
  parseRejectIsIoFree: false,
  requiresApproval: false,
  run: runRefresh,
  summary: "Ingest recent GitHub/Slack/Linear/Notion activity into the local bronze corpus",
  usage: USAGE,
});
