/**
 * `slopweaver refresh` — the bronze ingest across every source. Bare `refresh` stays GitHub-only for
 * back-compat; `--source <id>` (repeatable) and `--all-sources` select Slack/Linear/Notion/GitHub, each
 * fetched over its own incremental window (per-source watermark; `--since`/`--all` override depth,
 * default ~90 days for the new sources), projected into `CorpusRecord`s, and committed through the one
 * write+watermark path (`ingestSource`). A requested source with no token is a usage error before any
 * network.
 *
 * A thin effectful shell: every pure decision (flag parsing, source selection, window planning, the
 * missing-token diagnostics, the result summary + exit code) comes from {@link ./core}; the token reads,
 * connector factories, and ingest IO are INJECTED via {@link runRefreshWithDeps}, so the short-circuit and
 * summary behaviour is unit-tested with plain fakes. `runRefresh(argv)` wires production dependencies.
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
import { readWatermark } from "../../../corpus/watermark.js";
import { yyyyMmDdTodayPlus } from "../../../lib/date.js";
import { logger } from "../../../lib/logger.js";
import { createProgressEmitter } from "../../../lib/progress.js";
import { ok, type Result } from "../../../lib/result.js";
import { defineCommand } from "../../defineCommand.js";
import { EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import {
  buildRefreshWindows,
  missingTokenDiagnostics,
  parseRefreshOptions,
  type RefreshOptions,
  type RefreshWindow,
  refreshExitCode,
  refreshWindowLogLine,
  selectRefreshSources,
  summariseRefreshResults,
  type TokenedSource,
} from "./core.js";
import {
  hydrateOneSource,
  type MemberHydrationResult,
  type MemberTokens,
  summariseMemberHydration,
} from "./members.js";

const USAGE =
  "usage: slopweaver refresh [--repo owner/repo] [--source github|slack|linear|notion]... [--all-sources] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--all] [--slack-channel <id>]... [--lookback-days N] [--no-enrich]";

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
  source: TokenedSource;
  token: string;
  window: ExportWindow;
  slackChannels: readonly string[];
  home: string;
}): SourceIngestJob {
  const run = async (): Promise<Result<{ records: readonly CorpusRecord[]; warnings: readonly string[] }>> => {
    if (source === "slack") {
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

/** The Slack READ token: a user token wins; a bot token is the fallback with a limited-visibility warning. */
function slackReadToken(): { token?: string; warning?: string } {
  return resolveSlackReadToken({ botToken: slackBotToken(), userToken: slackUserToken() });
}

/** Resolve each tokened source's token (Slack read-token vs Linear/Notion env), for the missing-token gate. */
function resolveTokens(): Readonly<Partial<Record<TokenedSource, string | undefined>>> {
  return { linear: linearToken(), notion: notionToken(), slack: slackReadToken().token };
}

/** The injectable effectful seams the `refresh` shell composes (fakes in tests, production in {@link runRefresh}). */
export interface RefreshDeps {
  readonly nowDate: () => Date;
  readonly home: () => string;
  readonly resolveTokens: () => Readonly<Partial<Record<TokenedSource, string | undefined>>>;
  readonly slackReadToken: () => { token?: string; warning?: string };
  readonly buildGithubJob: typeof githubJob;
  readonly buildSourceJob: typeof sourceJob;
  readonly readWatermark: (args: { home: string; source: CorpusSource }) => string | undefined;
  readonly ingestSources: typeof ingestSources;
  /** Member hydration for ONE source (PR4.1) — optional so pre-PR4.1 refresh tests need no extra seam. */
  readonly hydrateMember?: (args: {
    source: CorpusSource;
    home: string;
    fetchedAtIso: string;
    repoSlug?: string;
  }) => Promise<MemberHydrationResult | undefined>;
  readonly logger: {
    out: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
    info: (m: string) => void;
  };
  readonly onProgress?: (p: { phase: string; label: string; done: number; total: number; written?: number }) => void;
}

/**
 * Build ONE source's ingest job (effectful factory): the GitHub REST/GraphQL job, or a tokened source
 * (Slack/Linear/Notion). Returns `undefined` for the synthetic `gold` source (never fetched). A GitHub
 * repo-resolution error propagates as an error Result.
 */
function buildOneSourceJob({
  source,
  window,
  options,
  home,
  deps,
}: {
  source: CorpusSource;
  window: RefreshWindow["window"];
  options: RefreshOptions;
  home: string;
  deps: RefreshDeps;
}): Result<SourceIngestJob | undefined> {
  if (source === "github") {
    return deps.buildGithubJob({ noEnrich: options.noEnrich, repoSlug: options.repo, window });
  }
  if (source === "gold") {
    return ok(undefined); // `gold` is synthetic and never fetched — narrows source to TokenedSource below.
  }
  const read = source === "slack" ? deps.slackReadToken() : undefined;
  if (read?.warning !== undefined) {
    deps.logger.warn(read.warning);
  }
  const token = source === "slack" ? read!.token! : deps.resolveTokens()[source]!;
  return ok(deps.buildSourceJob({ home, slackChannels: options.slackChannels, source, token, window }));
}

/** Build the ordered source jobs (effectful factories) + emit each window line; a GitHub repo error stops it. */
function buildRefreshJobs({
  windows,
  options,
  home,
  today,
  deps,
}: {
  windows: readonly RefreshWindow[];
  options: RefreshOptions;
  home: string;
  today: string;
  deps: RefreshDeps;
}): Result<readonly SourceIngestJob[]> {
  const jobs: SourceIngestJob[] = [];
  for (const { source, window } of windows) {
    const built = buildOneSourceJob({ deps, home, options, source, window });
    if (built.ok === false) {
      return built;
    }
    if (built.value !== undefined) {
      jobs.push(built.value);
      deps.logger.info(refreshWindowLogLine({ source, today, window }));
    }
  }
  return ok(jobs);
}

/** A validated, go-ahead refresh request (the resolved options + sources + home). */
interface RefreshRequest {
  readonly options: RefreshOptions;
  readonly sources: readonly CorpusSource[];
  readonly home: string;
}

/**
 * Parse + validate the argv into a go-ahead request, or an early exit code (help / bad flags / unknown
 * source / a requested non-GitHub source with no token — the last checked BEFORE any network or write).
 * Emits the diagnostics through the injected logger.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @param deps the effectful seams (logger + token reads)
 * @returns the validated request, or the exit code to return
 */
function resolveRefreshRequest({
  argv,
  deps,
}: {
  argv: readonly string[];
  deps: RefreshDeps;
}): { kind: "exit"; code: number } | { kind: "go"; request: RefreshRequest } {
  const rawRest = argv.slice(3);
  if (rawRest.includes("--help") || rawRest.includes("-h")) {
    deps.logger.out(USAGE);
    return { code: EXIT_OK, kind: "exit" };
  }
  const parsed = parseRefreshOptions({ rest: rawRest });
  if (parsed.ok === false) {
    reportUsageErrors({ errors: parsed.errors, sink: deps.logger });
    return { code: EXIT_USAGE, kind: "exit" };
  }
  const chosen = selectRefreshSources({ allSources: parsed.value.allSources, sources: parsed.value.sources });
  if (chosen.ok === false) {
    reportUsageErrors({ errors: chosen.errors, sink: deps.logger });
    return { code: EXIT_USAGE, kind: "exit" };
  }
  const missing = missingTokenDiagnostics({ selectedSources: chosen.value, tokens: deps.resolveTokens() });
  if (missing.length > 0) {
    missing.forEach((e) => {
      deps.logger.error(e);
    });
    return { code: EXIT_USAGE, kind: "exit" };
  }
  return {
    kind: "go",
    request: { home: parsed.value.home ?? deps.home(), options: parsed.value, sources: chosen.value },
  };
}

/** Emit each error line followed by the usage line (the shared bad-flags/unknown-source report). */
function reportUsageErrors({ errors, sink }: { errors: readonly string[]; sink: RefreshDeps["logger"] }): void {
  errors.forEach((e) => {
    sink.error(e);
  });
  sink.error(USAGE);
}

/**
 * Run the refresh verb over injected dependencies — the testable shell.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @param deps the effectful seams
 * @returns the process exit code
 */
export async function runRefreshWithDeps({
  argv,
  deps,
}: {
  argv: readonly string[];
  deps: RefreshDeps;
}): Promise<number> {
  const resolved = resolveRefreshRequest({ argv, deps });
  if (resolved.kind === "exit") {
    return resolved.code;
  }
  const { options, sources, home } = resolved.request;

  const until = options.until ?? yyyyMmDdTodayPlus({ days: 1, now: deps.nowDate() });
  const windows = buildRefreshWindows({
    all: options.all,
    home,
    lookbackDays: options.lookbackDays,
    readWatermark: deps.readWatermark,
    sinceFlag: options.since,
    sources,
    until,
  });
  const jobsResult = buildRefreshJobs({
    deps,
    home,
    options,
    today: yyyyMmDdTodayPlus({ days: 0, now: deps.nowDate() }),
    windows,
  });
  if (jobsResult.ok === false) {
    jobsResult.errors.forEach((e) => {
      deps.logger.error(e);
    });
    return EXIT_USAGE;
  }

  const outcome = await deps.ingestSources({
    home,
    jobs: [...jobsResult.value],
    ...(deps.onProgress !== undefined ? { onProgress: deps.onProgress } : {}),
  });
  const results = outcome.ok ? outcome.value : [];
  const summary = summariseRefreshResults({ bronzePath: bronzeDir({ home }), results });
  for (const line of summary.lines) {
    deps.logger[line.level](line.text);
  }
  await hydrateMembersStep({ deps, fetchedAtIso: deps.nowDate().toISOString(), home, options, sources });
  return refreshExitCode({ anyFailed: summary.anyFailed, totalWritten: summary.totalWritten });
}

/**
 * Hydrate each selected source's members after activity ingest, emitting non-blocking `members:<source>`
 * progress and folding the results into the summary. Hydration is WARNING-only — it never changes the
 * refresh exit code. A no-op when the member seam isn't injected (pre-PR4.1 test decks).
 */
async function hydrateMembersStep({
  deps,
  sources,
  home,
  options,
  fetchedAtIso,
}: {
  deps: RefreshDeps;
  sources: readonly CorpusSource[];
  home: string;
  options: RefreshOptions;
  fetchedAtIso: string;
}): Promise<void> {
  if (deps.hydrateMember === undefined) {
    return;
  }
  const results: MemberHydrationResult[] = [];
  for (const [index, source] of sources.entries()) {
    deps.onProgress?.({ done: index, label: source, phase: "members", total: sources.length });
    const result = await deps.hydrateMember({
      fetchedAtIso,
      home,
      source,
      ...(options.repo !== undefined ? { repoSlug: options.repo } : {}),
    });
    if (result !== undefined) {
      results.push(result);
    }
    deps.onProgress?.({
      done: index + 1,
      label: source,
      phase: "members",
      total: sources.length,
      ...(result !== undefined ? { written: result.written } : {}),
    });
  }
  for (const line of summariseMemberHydration({ results })) {
    deps.logger[line.level](line.text);
  }
}

/** Production dependencies for {@link runRefreshWithDeps} (real token reads, connector factories, ingest). */
function productionRefreshDeps(): RefreshDeps {
  const progress = createProgressEmitter({ verb: "refresh" });
  return {
    buildGithubJob: githubJob,
    buildSourceJob: sourceJob,
    home: slopweaverHome,
    hydrateMember: async ({ source, home, fetchedAtIso, repoSlug }) => {
      const repo = repoSlug !== undefined ? parseRepositorySlug({ slug: repoSlug }) : resolveRepository();
      const github = githubToken();
      const linear = linearToken();
      const notion = notionToken();
      const slack = slackReadToken().token;
      const tokens: MemberTokens = {
        ...(github !== undefined ? { github } : {}),
        ...(linear !== undefined ? { linear } : {}),
        ...(notion !== undefined ? { notion } : {}),
        ...(slack !== undefined ? { slack } : {}),
      };
      return hydrateOneSource({
        fetchedAtIso,
        home,
        source,
        tokens,
        ...(repo.ok ? { githubOrg: repo.value.owner } : {}),
      });
    },
    ingestSources,
    logger: {
      error: (m) => {
        logger.error(m);
      },
      info: (m) => {
        logger.info(m);
      },
      out: (m) => {
        logger.out(m);
      },
      warn: (m) => {
        logger.warn(m);
      },
    },
    nowDate: () => new Date(),
    onProgress: (p) => {
      progress.update({
        counts: p.written !== undefined ? { written: p.written } : {},
        done: p.done,
        phase: `${p.phase}:${p.label}`,
        total: p.total,
      });
    },
    readWatermark,
    resolveTokens,
    slackReadToken,
  };
}

/**
 * Run the refresh verb.
 *
 * @param argv the full process argv (verb tail starts at index 3)
 * @returns the process exit code
 */
export async function runRefresh(argv: readonly string[]): Promise<number> {
  return runRefreshWithDeps({ argv, deps: productionRefreshDeps() });
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
