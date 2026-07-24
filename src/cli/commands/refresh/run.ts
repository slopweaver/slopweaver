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
  progressJsonEnabled,
  resolveRepository,
  slackBotToken,
  slackUserToken,
  slopweaverHome,
} from "../../../config.js";
import { bronzeDir } from "../../../corpus/corpusPaths.js";
import { fetchGithubCurated, makeGithubCuratedApi, projectGithubCurated } from "../../../corpus/github/curated.js";
import { type FetchProgress, githubFetchItems } from "../../../corpus/github/fetch.js";
import { enumerateOrgRepos, makeGithubOrgApi } from "../../../corpus/github/org.js";
import { fetchOrgActivity, type OrgRepoProgress } from "../../../corpus/github/orgActivity.js";
import { projectGithubRecords } from "../../../corpus/github/project.js";
import { advanceGithubRepoWatermarks, readGithubRepoWatermarks } from "../../../corpus/github/repoWatermark.js";
import { ingestSources, type SourceIngestJob } from "../../../corpus/ingestSource.js";
import { fetchLinearActivity, makeLinearApi } from "../../../corpus/linear/fetch.js";
import { projectLinearRecords } from "../../../corpus/linear/project.js";
import { fetchNotionActivity, makeNotionApi } from "../../../corpus/notion/fetch.js";
import { projectNotionRecords } from "../../../corpus/notion/project.js";
import { type SourceProgress, sourceHeartbeat, toRichProgressEvent } from "../../../corpus/progress.js";
import { fetchSlackActivity, makeSlackApi, resolveSlackReadToken } from "../../../corpus/slack/fetch.js";
import { slackOwnerBotIdentity } from "../../../corpus/slack/ownerBot.js";
import { projectSlackRecords } from "../../../corpus/slack/project.js";
import { readThreadCursors, writeThreadCursors } from "../../../corpus/slack/threadCursors.js";
import type { CorpusRecord, CorpusSource, ExportWindow } from "../../../corpus/types.js";
import { readWatermark } from "../../../corpus/watermark.js";
import { yyyyMmDdTodayPlus } from "../../../lib/date.js";
import { logger } from "../../../lib/logger.js";
import { createRichProgressEmitter, type RichProgressEvent, unrefIntervalStallTimer } from "../../../lib/progress.js";
import { ok, type Result } from "../../../lib/result.js";
import { loadProfile } from "../../../profileStore.js";
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
import {
  hydrateOneSourceStructures,
  type StructureGithubOptions,
  type StructureHydrationResult,
  summariseStructureHydration,
} from "./structures.js";

const USAGE =
  "usage: slopweaver refresh [--repo owner/repo] [--source github|slack|linear|notion]... [--all-sources] [--since YYYY-MM-DD] [--until YYYY-MM-DD] [--all] [--slack-channel <id>]... [--lookback-days N] [--no-enrich] [--all-repos [--github-org <org>] [--include-repo <glob>]... [--exclude-repo <glob>]... [--repo-cap N]] [--slack-membership-cap N]";

/** GitHub org-mode fan-out: at most this many repos fetched at once (the concurrency ceiling). */
const ORG_CONCURRENCY = 3;
/** GitHub org-mode fan-out: repo fetches STARTED per second (octokit's own throttle paces the inner calls). */
const ORG_RATE_PER_SEC = 1;

/** Build the GitHub ingest job (unchanged discovery+enrichment behaviour, wrapped as a source job). */
function githubJob({
  repoSlug,
  window,
  noEnrich,
  onProgress,
}: {
  repoSlug: string | undefined;
  window: ExportWindow;
  noEnrich: boolean;
  onProgress?: FetchProgress;
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
      const fetched = await githubFetchItems({
        enrich,
        ...(token !== undefined ? { token } : {}),
        ...(onProgress !== undefined ? { onProgress } : {}),
      })({ repo, window });
      if (fetched.ok === false) {
        return fetched;
      }
      const container = `${repo.owner}/${repo.repo}`;
      const activity = projectGithubRecords({ items: fetched.value, repo: container });
      // The curated lane (discussions/releases/milestones/CODEOWNERS) is additive + best-effort — a disabled
      // surface warns, never fails. It needs auth, so it only runs when a token is present.
      const curated =
        token !== undefined
          ? await fetchGithubCurated({ api: makeGithubCuratedApi({ token }), repo })
          : { items: undefined, warnings: [] };
      const curatedRecords =
        curated.items !== undefined ? projectGithubCurated({ items: curated.items, repo: container }) : [];
      return ok({ records: [...activity, ...curatedRecords], warnings: [...fetched.warnings, ...curated.warnings] });
    },
    source: "github",
    window,
  });
}

/** Resolve the org to enumerate in org mode: `--github-org`, else `--repo` owner, else the current remote. */
function resolveGithubOrg({ options }: { options: RefreshOptions }): Result<string> {
  if (options.githubOrg !== undefined) {
    return ok(options.githubOrg);
  }
  const repoResult = options.repo !== undefined ? parseRepositorySlug({ slug: options.repo }) : resolveRepository();
  return repoResult.ok ? ok(repoResult.value.owner) : repoResult;
}

/**
 * Build the GitHub ORG-MODE ingest job (`--all-repos`): enumerate + select the org's repos, fan the existing
 * per-repo pipeline over them (concurrency-capped + rate-paced), and resume each from its own per-repo
 * watermark. A repo-enumeration failure fails the job; one repo's fetch failure is a warning, never fatal.
 */
function githubOrgJob({
  options,
  window,
  home,
  onRepoProgress,
}: {
  options: RefreshOptions;
  window: ExportWindow;
  home: string;
  onRepoProgress?: OrgRepoProgress;
}): Result<SourceIngestJob> {
  const orgResult = resolveGithubOrg({ options });
  if (orgResult.ok === false) {
    return orgResult;
  }
  const org = orgResult.value;
  const token = githubToken();
  const enrich = !options.noEnrich && token !== undefined;
  if (token === undefined) {
    logger.warn("no GitHub auth (set GITHUB_TOKEN or run `gh auth login`) — org mode limited to public repos");
  }
  return ok({
    label: `org:${org} (all-repos)`,
    run: () =>
      runGithubOrgActivity({
        enrich,
        home,
        options,
        org,
        window,
        ...(token !== undefined ? { token } : {}),
        ...(onRepoProgress !== undefined ? { onRepoProgress } : {}),
      }),
    source: "github",
    window,
  });
}

/** Enumerate the org's repos then fan the per-repo pipeline over them, advancing each repo's own watermark. */
async function runGithubOrgActivity({
  org,
  options,
  window,
  home,
  enrich,
  token,
  onRepoProgress,
}: {
  org: string;
  options: RefreshOptions;
  window: ExportWindow;
  home: string;
  enrich: boolean;
  token?: string;
  onRepoProgress?: OrgRepoProgress;
}): Promise<Result<{ records: readonly CorpusRecord[]; warnings: readonly string[] }>> {
  const enumerated = await enumerateOrgRepos({
    api: makeGithubOrgApi({ token }),
    cap: options.repoCap,
    exclude: options.excludeRepos,
    include: options.includeRepos,
    org,
  });
  if (enumerated.ok === false) {
    return enumerated;
  }
  const activity = await fetchOrgActivity({
    concurrency: ORG_CONCURRENCY,
    fetchItems: githubFetchItems({ enrich, ...(token !== undefined ? { token } : {}) }),
    ratePerSec: ORG_RATE_PER_SEC,
    repoCursors: readGithubRepoWatermarks({ home }),
    repos: enumerated.value.repos,
    window,
    ...(onRepoProgress !== undefined ? { onProgress: onRepoProgress } : {}),
  });
  const advanced = advanceGithubRepoWatermarks({ advances: activity.advances, home });
  return ok({
    records: activity.records,
    warnings: [
      ...enumerated.value.warnings,
      `github org mode: ${String(enumerated.value.repos.length)} repo(s) selected`,
      ...activity.warnings,
      ...(advanced.ok ? [] : advanced.errors.map((e) => `per-repo watermark persist failed: ${e}`)),
    ],
  });
}

/**
 * Fetch + project Slack activity into records. PR4.5: the owner's own bot identity (from `profile.json`,
 * when set) is resolved back to the owner in projection (me-to-me), and every record inherits its
 * channel's visibility via the projector's single stamp choke-point. Extracted to keep `sourceJob` lean.
 */
async function ingestSlack({
  token,
  window,
  slackChannels,
  home,
  progress,
}: {
  token: string;
  window: ExportWindow;
  slackChannels: readonly string[];
  home: string;
  progress: { onProgress?: SourceProgress };
}): Promise<Result<{ records: readonly CorpusRecord[]; warnings: readonly string[] }>> {
  const fetched = await fetchSlackActivity({
    api: makeSlackApi({ token }),
    threadCursors: readThreadCursors({ home }),
    window,
    ...progress,
    ...(slackChannels.length > 0 ? { channelFilter: slackChannels } : {}),
  });
  if (fetched.ok === false) {
    return fetched;
  }
  const stored = writeThreadCursors({ cursors: fetched.value.threadCursors, home });
  const warnings = stored.ok
    ? fetched.value.warnings
    : [...fetched.value.warnings, ...stored.errors.map((e) => `thread-cursor persist failed: ${e}`)];
  const ownerBot = slackOwnerBotIdentity({ slackBot: loadProfile({ home })?.slackBot });
  return ok({
    records: projectSlackRecords({
      channels: fetched.value.channels,
      curated: fetched.value.curated,
      maps: fetched.value.maps,
      ...(ownerBot !== undefined ? { ownerBot } : {}),
    }),
    warnings,
  });
}

/** Build a Slack/Linear/Notion job from its token + window (token presence checked by the caller). */
function sourceJob({
  source,
  token,
  window,
  slackChannels,
  home,
  onProgress,
}: {
  source: TokenedSource;
  token: string;
  window: ExportWindow;
  slackChannels: readonly string[];
  home: string;
  onProgress?: SourceProgress;
}): SourceIngestJob {
  const progress = onProgress !== undefined ? { onProgress } : {};
  const run = async (): Promise<Result<{ records: readonly CorpusRecord[]; warnings: readonly string[] }>> => {
    if (source === "slack") {
      return ingestSlack({ home, progress, slackChannels, token, window });
    }
    if (source === "linear") {
      const fetched = await fetchLinearActivity({ api: makeLinearApi({ token }), window, ...progress });
      return fetched.ok
        ? ok({ records: projectLinearRecords(fetched.value), warnings: fetched.value.warnings })
        : fetched;
    }
    const fetched = await fetchNotionActivity({ api: makeNotionApi({ token }), window, ...progress });
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

/** All four sources' tokens (present ones only) — the member/structure hydration lanes' token bag. */
function allSourceTokens(): MemberTokens {
  const github = githubToken();
  const linear = linearToken();
  const notion = notionToken();
  const slack = slackReadToken().token;
  return {
    ...(github !== undefined ? { github } : {}),
    ...(linear !== undefined ? { linear } : {}),
    ...(notion !== undefined ? { notion } : {}),
    ...(slack !== undefined ? { slack } : {}),
  };
}

/** The GitHub structural selection (only in org mode, when the org resolves) — else no GitHub structure. */
function githubStructureOptions({ options }: { options: RefreshOptions }): { github?: StructureGithubOptions } {
  if (!options.allRepos) {
    return {};
  }
  const org = resolveGithubOrg({ options });
  if (org.ok === false) {
    return {};
  }
  return {
    github: {
      excludeRepos: options.excludeRepos,
      includeRepos: options.includeRepos,
      org: org.value,
      ...(options.repoCap !== undefined ? { repoCap: options.repoCap } : {}),
    },
  };
}

/** The injectable effectful seams the `refresh` shell composes (fakes in tests, production in {@link runRefresh}). */
export interface RefreshDeps {
  readonly nowDate: () => Date;
  readonly home: () => string;
  readonly resolveTokens: () => Readonly<Partial<Record<TokenedSource, string | undefined>>>;
  readonly slackReadToken: () => { token?: string; warning?: string };
  readonly buildGithubJob: typeof githubJob;
  /** GitHub ORG-MODE job builder (PR4.2) — optional so pre-PR4.2 test decks need no extra seam. */
  readonly buildGithubOrgJob?: typeof githubOrgJob;
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
  /** Structural hydration for ONE source (PR4.2) — optional so pre-PR4.2 test decks need no extra seam. */
  readonly hydrateStructure?: (args: {
    source: CorpusSource;
    home: string;
    fetchedAtIso: string;
    options: RefreshOptions;
  }) => Promise<StructureHydrationResult | undefined>;
  readonly logger: {
    out: (m: string) => void;
    warn: (m: string) => void;
    error: (m: string) => void;
    info: (m: string) => void;
  };
  readonly onProgress?: (p: { phase: string; label: string; done: number; total: number; written?: number }) => void;
  /** The connector-level streamed progress seam (PR4.4c) — per-channel/repo/page heartbeats + previews. */
  readonly sourceProgress?: SourceProgress;
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
    return buildGithubSourceJob({ deps, home, options, window });
  }
  if (source === "gold") {
    return ok(undefined); // `gold` is synthetic and never fetched — narrows source to TokenedSource below.
  }
  const read = source === "slack" ? deps.slackReadToken() : undefined;
  if (read?.warning !== undefined) {
    deps.logger.warn(read.warning);
  }
  const token = source === "slack" ? read!.token! : deps.resolveTokens()[source]!;
  return ok(
    deps.buildSourceJob({
      home,
      slackChannels: options.slackChannels,
      source,
      token,
      window,
      ...(deps.sourceProgress !== undefined ? { onProgress: deps.sourceProgress } : {}),
    }),
  );
}

/** Adapt the connector progress seam into GitHub's per-item hook (single-repo mode). */
export function githubItemProgress({ sourceProgress }: { sourceProgress: SourceProgress }): FetchProgress {
  return ({ number, index, total }) => {
    sourceProgress(
      sourceHeartbeat({
        currentItem: { title: `#${String(number)}` },
        done: index,
        phase: "items",
        source: "github",
        total,
      }),
    );
  };
}

/** Adapt the connector progress seam into GitHub's per-repo hook (org mode) — names the repo + its yield. */
export function githubRepoProgress({ sourceProgress }: { sourceProgress: SourceProgress }): OrgRepoProgress {
  return ({ done, total, repo, recordCount }) => {
    sourceProgress(
      sourceHeartbeat({
        currentItem: { title: repo },
        done,
        metrics: { records: recordCount },
        phase: "repos",
        source: "github",
        total,
      }),
    );
  };
}

/** Build the GitHub ingest job: the org-mode fan-out when `--all-repos` (+ seam), else the single-repo job. */
function buildGithubSourceJob({
  options,
  window,
  home,
  deps,
}: {
  options: RefreshOptions;
  window: RefreshWindow["window"];
  home: string;
  deps: RefreshDeps;
}): Result<SourceIngestJob> {
  const sourceProgress = deps.sourceProgress;
  if (!options.allRepos || deps.buildGithubOrgJob === undefined) {
    const onProgress = sourceProgress !== undefined ? githubItemProgress({ sourceProgress }) : undefined;
    return deps.buildGithubJob({
      noEnrich: options.noEnrich,
      repoSlug: options.repo,
      window,
      ...(onProgress !== undefined ? { onProgress } : {}),
    });
  }
  const onRepoProgress = sourceProgress !== undefined ? githubRepoProgress({ sourceProgress }) : undefined;
  return deps.buildGithubOrgJob({ home, options, window, ...(onRepoProgress !== undefined ? { onRepoProgress } : {}) });
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
    orgMode: options.allRepos,
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
  const fetchedAtIso = deps.nowDate().toISOString();
  await hydrateMembersStep({ deps, fetchedAtIso, home, options, sources });
  await hydrateStructuresStep({ deps, fetchedAtIso, home, options, sources });
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

/**
 * Hydrate each selected source's STRUCTURE after activity + member hydration, emitting non-blocking
 * `structures:<source>` progress and folding the results into the summary. Structural hydration is
 * WARNING-only — it never changes the refresh exit code. A no-op when the seam isn't injected.
 */
async function hydrateStructuresStep({
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
  if (deps.hydrateStructure === undefined) {
    return;
  }
  const results: StructureHydrationResult[] = [];
  for (const [index, source] of sources.entries()) {
    deps.onProgress?.({ done: index, label: source, phase: "structures", total: sources.length });
    const result = await deps.hydrateStructure({ fetchedAtIso, home, options, source });
    if (result !== undefined) {
      results.push(result);
    }
    deps.onProgress?.({
      done: index + 1,
      label: source,
      phase: "structures",
      total: sources.length,
      ...(result !== undefined ? { written: result.written } : {}),
    });
  }
  for (const line of summariseStructureHydration({ results })) {
    deps.logger[line.level](line.text);
  }
}

/** Production member hydration for ONE source (real token reads + the resolved org). */
async function productionHydrateMember({
  source,
  home,
  fetchedAtIso,
  repoSlug,
}: {
  source: CorpusSource;
  home: string;
  fetchedAtIso: string;
  repoSlug?: string;
}): Promise<MemberHydrationResult | undefined> {
  const repo = repoSlug !== undefined ? parseRepositorySlug({ slug: repoSlug }) : resolveRepository();
  return hydrateOneSource({
    fetchedAtIso,
    home,
    source,
    tokens: allSourceTokens(),
    ...(repo.ok ? { githubOrg: repo.value.owner } : {}),
  });
}

/** Production structural hydration for ONE source (real token reads + the org-mode selection). */
async function productionHydrateStructure({
  source,
  home,
  fetchedAtIso,
  options,
}: {
  source: CorpusSource;
  home: string;
  fetchedAtIso: string;
  options: RefreshOptions;
}): Promise<StructureHydrationResult | undefined> {
  return hydrateOneSourceStructures({
    fetchedAtIso,
    home,
    source,
    tokens: allSourceTokens(),
    ...githubStructureOptions({ options }),
    ...(options.slackMembershipCap !== undefined ? { slackMembershipCap: options.slackMembershipCap } : {}),
  });
}

/**
 * Map a coarse hydration event (`members`/`structures`) to a rich heartbeat. Ingest `start`/`done` events
 * are NOT surfaced here — the connector stream already narrates the crawl and the summary reports the
 * written counts, so re-emitting them would just add noise. Pure.
 */
export function hydrationHeartbeat({
  phase,
  label,
  done,
  total,
  written,
}: {
  phase: string;
  label: string;
  done: number;
  total: number;
  written?: number;
}): RichProgressEvent {
  return {
    currentItem: { title: label },
    done,
    lane: "heartbeat",
    phase,
    total,
    ...(written !== undefined ? { metrics: { written } } : {}),
  };
}

/** Production dependencies for {@link runRefreshWithDeps} (real token reads, connector factories, ingest). */
function productionRefreshDeps(): RefreshDeps {
  // The long crawl is where a wedged API call actually stalls — so refresh wires the non-blocking watchdog.
  // Human lines stream to stderr; the machine JSON lane is off unless opted in (so the watch view is clean).
  const emitter = createRichProgressEmitter({
    stallTimer: unrefIntervalStallTimer,
    verb: "refresh",
    ...(progressJsonEnabled() ? {} : { machineSink: () => {} }),
  });
  return {
    buildGithubJob: githubJob,
    buildGithubOrgJob: githubOrgJob,
    buildSourceJob: sourceJob,
    home: slopweaverHome,
    hydrateMember: productionHydrateMember,
    hydrateStructure: productionHydrateStructure,
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
      if (p.phase === "members" || p.phase === "structures") {
        emitter.emit(hydrationHeartbeat(p));
      }
    },
    readWatermark,
    resolveTokens,
    slackReadToken,
    sourceProgress: (event) => {
      emitter.emit(toRichProgressEvent({ event }));
    },
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
