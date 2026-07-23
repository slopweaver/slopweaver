/**
 * The per-repo GitHub org-mode watermark: the max `tsIso` observed for EACH `owner/repo`, so an org-mode
 * re-run resumes each repo from its own cursor instead of re-scanning every repo's history. Kept in a file
 * separate from the per-source watermark (`.github-repos.watermark.json`) so one busy repo can never advance
 * the whole org past quieter repos — the scale guard that makes "all my repos" safe to re-run. Merge is MAX
 * at the leaf (a narrower re-run can't move a cursor backwards); writes are atomic (tmp + rename).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { slopweaverHome } from "../../config.js";
import { isRecord } from "../../lib/parsers.js";
import { err, ok, type Result } from "../../lib/result.js";
import { githubReposWatermarkPath } from "../corpusPaths.js";

interface RepoWatermarkFile {
  readonly version: 1;
  readonly repos: Record<string, { readonly cursor: string }>;
}

const EMPTY: RepoWatermarkFile = { repos: {}, version: 1 };

/** One repo's cursor advance (`owner/repo` → the max observed `tsIso`). */
export interface RepoWatermarkAdvance {
  readonly repo: string;
  readonly cursor: string;
}

/** The max observed `tsIso` per repo key. Repos with no non-empty timestamp fall back to `until`. Pure. */
export function computeRepoWatermarks({
  observed,
  fallbackUntil,
}: {
  observed: readonly { repo: string; tsIso: string }[];
  fallbackUntil: string;
}): readonly RepoWatermarkAdvance[] {
  const maxByRepo = new Map<string, string>();
  const seen = new Set<string>();
  for (const { repo, tsIso } of observed) {
    seen.add(repo);
    const currentMax = maxByRepo.get(repo);
    if (tsIso.length > 0 && (currentMax === undefined || tsIso > currentMax)) {
      maxByRepo.set(repo, tsIso);
    }
  }
  return [...seen].map((repo) => ({ cursor: maxByRepo.get(repo) ?? fallbackUntil, repo }));
}

/** Read + validate the per-repo watermark file; anything unrecognised degrades to empty. */
function readRepoWatermarkFile({ home }: { home: string }): RepoWatermarkFile {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(githubReposWatermarkPath({ home }), "utf8"));
  } catch {
    return EMPTY;
  }
  if (!isRecord(raw) || !isRecord(raw["repos"])) {
    return EMPTY;
  }
  const repos: Record<string, { cursor: string }> = {};
  for (const [key, value] of Object.entries(raw["repos"])) {
    if (isRecord(value) && typeof value["cursor"] === "string") {
      repos[key] = { cursor: value["cursor"] };
    }
  }
  return { repos, version: 1 };
}

/**
 * The stored cursor per repo key (`owner/repo`), as a lookup map.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the `owner/repo` → cursor map (empty when no file)
 */
export function readGithubRepoWatermarks({
  home = slopweaverHome(),
}: {
  home?: string;
} = {}): ReadonlyMap<string, string> {
  const file = readRepoWatermarkFile({ home });
  return new Map(Object.entries(file.repos).map(([repo, value]) => [repo, value.cursor]));
}

/** Merge incoming advances into the current file, MAX at every repo cursor. Pure. */
function mergeRepoWatermarks({
  current,
  incoming,
}: {
  current: RepoWatermarkFile;
  incoming: readonly RepoWatermarkAdvance[];
}): RepoWatermarkFile {
  const repos = { ...current.repos };
  for (const { repo, cursor } of incoming) {
    const existing = repos[repo]?.cursor;
    if (existing === undefined || cursor > existing) {
      repos[repo] = { cursor };
    }
  }
  return { repos, version: 1 };
}

/**
 * Advance the per-repo watermark file to include `advances` (MAX-merged), written atomically.
 *
 * @param advances the per-repo cursors to merge in
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the written path, or an error on write failure
 */
export function advanceGithubRepoWatermarks({
  advances,
  home = slopweaverHome(),
}: {
  advances: readonly RepoWatermarkAdvance[];
  home?: string;
}): Result<{ path: string }> {
  const path = githubReposWatermarkPath({ home });
  const merged = mergeRepoWatermarks({ current: readRepoWatermarkFile({ home }), incoming: advances });
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error: unknown) {
    return err([error instanceof Error ? error.message : `failed to write per-repo watermark ${path}`]);
  }
  return ok({ path });
}
