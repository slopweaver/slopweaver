/**
 * The GitHub org-mode ACTIVITY fan-out: run the EXISTING per-repo search/activity pipeline
 * ({@link ../github/fetch.FetchGithubItems}) across every selected org repo, bounded by a shared concurrency
 * cap ({@link ../../lib/resilience.createConcurrencyLimiter}) and paced by a shared rate gate
 * ({@link ../../lib/resilience.createRateScheduler}) so a large org never becomes a thundering herd. Each
 * repo windows from its OWN per-repo cursor (so a re-run re-fetches nothing unchanged), and one repo's fetch
 * failure is a warning + skip — never fatal — so a single unreadable repo can't sink the whole org pass.
 */

import type { Repository } from "../../config.js";
import { createConcurrencyLimiter, createRateScheduler } from "../../lib/resilience.js";
import type { CorpusRecord, ExportWindow } from "../types.js";
import { resolveSince } from "../watermark.js";
import type { FetchGithubItems } from "./fetch.js";
import { projectGithubRecords } from "./project.js";
import { computeRepoWatermarks, type RepoWatermarkAdvance } from "./repoWatermark.js";

/** Per-repo progress (non-blocking) — fired as each repo's fetch completes, naming the repo + its yield. */
export type OrgRepoProgress = (progress: { done: number; total: number; repo: string; recordCount: number }) => void;

/** The combined org-activity outcome: all repos' records, warnings, and each repo's per-repo cursor advance. */
export interface OrgActivityResult {
  readonly records: readonly CorpusRecord[];
  readonly warnings: readonly string[];
  readonly advances: readonly RepoWatermarkAdvance[];
}

/** One repo's fetch outcome (records + warnings + whether it was fetched at all, for the watermark advance). */
interface RepoOutcome {
  readonly repoKey: string;
  readonly fetched: boolean;
  readonly records: readonly CorpusRecord[];
  readonly warnings: readonly string[];
}

/** Fetch + project ONE repo over its own window; a fetch failure is a warning + skip (never a throw). */
async function fetchOneRepo({
  repo,
  window,
  repoCursors,
  fetchItems,
}: {
  repo: Repository;
  window: ExportWindow;
  repoCursors: ReadonlyMap<string, string>;
  fetchItems: FetchGithubItems;
}): Promise<RepoOutcome> {
  const repoKey = `${repo.owner}/${repo.repo}`;
  const since = resolveSince({ cursor: repoCursors.get(repoKey), fallbackSince: window.since });
  const result = await fetchItems({ repo, window: { since, until: window.until } });
  if (result.ok === false) {
    return { fetched: false, records: [], repoKey, warnings: [`repo ${repoKey}: ${result.errors.join("; ")}`] };
  }
  return {
    fetched: true,
    records: projectGithubRecords({ items: result.value, repo: repoKey }),
    repoKey,
    warnings: result.warnings,
  };
}

/** The per-repo `{repo, tsIso}` observations from a fetched repo (empty-but-fetched still marks the repo seen). */
function repoObservations({ outcome }: { outcome: RepoOutcome }): readonly { repo: string; tsIso: string }[] {
  if (!outcome.fetched) {
    return []; // a failed repo is NOT advanced, so it retries next run
  }
  if (outcome.records.length === 0) {
    return [{ repo: outcome.repoKey, tsIso: "" }]; // seen-but-empty ⇒ advances to `until`, no re-scan
  }
  return outcome.records.map((record) => ({ repo: outcome.repoKey, tsIso: record.tsIso }));
}

/**
 * Fan the per-repo pipeline across the selected repos, concurrency-capped + rate-paced, windowing each from
 * its own cursor. Returns the combined records + warnings + each repo's cursor advance (empty/failed repos
 * handled per {@link repoObservations}).
 *
 * @param repos the selected repo coordinates
 * @param window the base window (`since` is the floor; a repo's own cursor wins when later)
 * @param repoCursors the per-repo stored cursors (`owner/repo` → cursor)
 * @param fetchItems the injected per-repo fetch seam (the existing GitHub pipeline)
 * @param concurrency the max repos fetched at once
 * @param ratePerSec the sustained per-repo-fetch rate ceiling
 * @param onProgress optional per-repo progress callback
 * @returns the combined records, warnings, and per-repo watermark advances
 */
export async function fetchOrgActivity({
  repos,
  window,
  repoCursors,
  fetchItems,
  concurrency,
  ratePerSec,
  onProgress,
}: {
  repos: readonly Repository[];
  window: ExportWindow;
  repoCursors: ReadonlyMap<string, string>;
  fetchItems: FetchGithubItems;
  concurrency: number;
  ratePerSec: number;
  onProgress?: OrgRepoProgress;
}): Promise<OrgActivityResult> {
  const limit = createConcurrencyLimiter({ concurrency });
  const gate = createRateScheduler({ ratePerSec });
  let done = 0;
  const outcomes = await Promise.all(
    repos.map((repo) =>
      limit(async () => {
        const outcome = await gate(() => fetchOneRepo({ fetchItems, repo, repoCursors, window }));
        done += 1;
        onProgress?.({ done, recordCount: outcome.records.length, repo: outcome.repoKey, total: repos.length });
        return outcome;
      }),
    ),
  );
  const observed = outcomes.flatMap((outcome) => repoObservations({ outcome }));
  return {
    advances: computeRepoWatermarks({ fallbackUntil: window.until, observed }),
    records: outcomes.flatMap((outcome) => outcome.records),
    warnings: outcomes.flatMap((outcome) => outcome.warnings),
  };
}
