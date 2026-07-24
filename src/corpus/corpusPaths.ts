/**
 * Leaf paths within the corpus (per-source, per-window). The corpus ROOTS (bronze/silver/gold/cache/
 * watermark) come from the one home-path contract, {@link stateHomePaths} — this module only builds the
 * finer paths under them, so the writer and reader can never disagree and no home path is derived twice.
 *
 *   $SLOPWEAVER_HOME/corpus/
 *   ├── bronze/<source>/<since>_<until>.jsonl   # CorpusRecord lines
 *   ├── silver/index/{directory,opportunities,identities}.json
 *   ├── silver/graph/graph.json
 *   ├── silver/digests/<source>.json            # distilled per-source digests
 *   ├── gold/{overview,where-to-look}.md + gold/by-source/<source>.md
 *   ├── .cache/distil/batches.json              # content-hash digest cache (rebuildable)
 *   └── .watermark.json                         # per-source resume cursor
 */
import { join } from "node:path";

import { slopweaverHome } from "../config.js";
import type { IdentitySource } from "../silver/identity.js";
import { stateHomePaths } from "../stateHome.js";
import type { CorpusSource, ExportWindow } from "./types.js";

/**
 * The bronze root (all sources) under the home.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute bronze directory path
 */
export function bronzeDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return stateHomePaths({ home }).corpus.bronze;
}

/**
 * The bronze dir for one source.
 *
 * @param source the corpus source
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute per-source bronze directory path
 */
export function bronzeSourceDir({ source, home = slopweaverHome() }: { source: CorpusSource; home?: string }): string {
  return join(bronzeDir({ home }), source);
}

/**
 * The member (person) bronze root — a SIBLING of `bronze` (see {@link stateHomePaths}). Member rows never
 * enter the `CorpusRecord` reader, which recurses `bronze/`.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute member bronze directory path
 */
export function memberDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return stateHomePaths({ home }).corpus.members;
}

/**
 * The member bronze JSONL file for one source (`members/<source>.jsonl`). One file per source, appended.
 *
 * @param source the identity source
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute member JSONL file path
 */
export function memberFile({ source, home = slopweaverHome() }: { source: IdentitySource; home?: string }): string {
  return join(memberDir({ home }), `${source}.jsonl`);
}

/**
 * The structural (person-scaffolding) bronze root — a SIBLING of `bronze` (see {@link stateHomePaths}).
 * Structure rows (org/team/repo/channel/…) never enter the `CorpusRecord` reader, which recurses `bronze/`.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute structure bronze directory path
 */
export function structureDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return stateHomePaths({ home }).corpus.structures;
}

/**
 * The structure bronze JSONL file for one source (`structures/<source>.jsonl`). One file per source, appended.
 *
 * @param source the identity source
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute structure JSONL file path
 */
export function structureFile({ source, home = slopweaverHome() }: { source: IdentitySource; home?: string }): string {
  return join(structureDir({ home }), `${source}.jsonl`);
}

/**
 * The per-repo GitHub org-mode watermark file (`owner/repo` → cursor). Separate from the per-source
 * watermark so a busy repo can't advance the whole org (see {@link stateHomePaths}.githubReposWatermark).
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute per-repo watermark file path
 */
export function githubReposWatermarkPath({ home = slopweaverHome() }: { home?: string } = {}): string {
  return stateHomePaths({ home }).corpus.githubReposWatermark;
}

/**
 * The consolidated silver structure directory/graph derive writes (`silver/index/structures.json`) — the
 * org-graph surface (orgs/teams/repos/channels/workflow-states/cycles + their relations) for PR10/PR18.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute structures JSON file path
 */
export function silverStructuresPath({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(silverIndexDir({ home }), "structures.json");
}

/**
 * The consolidated silver person dossier derive writes (`silver/index/people.json`) — the richer PR10/PR18
 * substrate (per canonical Person: identities + emails + aliases + attrs + raw member payloads), distinct
 * from the resolver-facing {@link silverIdentitiesPath}.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute people-dossier JSON file path
 */
export function silverPeoplePath({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(silverIndexDir({ home }), "people.json");
}

/** Make an ISO/date string safe as a filename segment (`:` and `.` are illegal on some filesystems). */
function safeSegment({ value }: { value: string }): string {
  return value.replace(/[:.]/g, "-");
}

/**
 * The bronze JSONL file for one source + window.
 *
 * @param source the corpus source
 * @param window the export window
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute bronze JSONL file path
 */
export function bronzeFile({
  source,
  window,
  home = slopweaverHome(),
}: {
  source: CorpusSource;
  window: ExportWindow;
  home?: string;
}): string {
  const name = `${safeSegment({ value: window.since })}_${safeSegment({ value: window.until })}.jsonl`;
  return join(bronzeSourceDir({ home, source }), name);
}

/**
 * The watermark file under the home.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute watermark file path
 */
export function watermarkPath({ home = slopweaverHome() }: { home?: string } = {}): string {
  return stateHomePaths({ home }).corpus.watermark;
}

/**
 * The PER-SOURCE watermark file (`corpus/watermarks/<source>.json`). Each source writes ONLY its own file,
 * so concurrent per-source refreshes (onboard runs them in parallel) can never clobber each other's resume
 * cursor the way a single shared `.watermark.json` read-modify-write would. The legacy combined file stays
 * readable as a migration fallback (see {@link ../corpus/watermark.readWatermark}).
 *
 * @param source the corpus source
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute per-source watermark file path
 */
export function sourceWatermarkPath({
  source,
  home = slopweaverHome(),
}: {
  source: CorpusSource;
  home?: string;
}): string {
  return join(stateHomePaths({ home }).corpus.root, "watermarks", `${source}.json`);
}

/**
 * The silver index dir (directory / opportunities / identities JSON).
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute silver index directory path
 */
export function silverIndexDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(stateHomePaths({ home }).corpus.silver, "index");
}

/**
 * The DERIVED cross-source identity map derive writes (`silver/index/identities.json`) — distinct from the
 * off-repo `$SLOPWEAVER_HOME/identity.json` roster ({@link stateHomePaths}.identityJson), which is the
 * human OVERRIDE input. Derive reads the roster and writes this derived artifact for PR10/PR18 to consume.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute derived-identities JSON file path
 */
export function silverIdentitiesPath({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(silverIndexDir({ home }), "identities.json");
}

/**
 * The silver graph dir.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute silver graph directory path
 */
export function silverGraphDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(stateHomePaths({ home }).corpus.silver, "graph");
}

/**
 * The silver digests dir (per-source distilled digests).
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute silver digests directory path
 */
export function silverDigestsDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(stateHomePaths({ home }).corpus.silver, "digests");
}

/**
 * The gold markdown dir.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute gold directory path
 */
export function goldDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return stateHomePaths({ home }).corpus.gold;
}

/**
 * The rebuildable cache dir (`.cache`, gitignored) — distil digests, embedding vectors.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute cache directory path
 */
export function cacheDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return stateHomePaths({ home }).corpus.cache;
}

/**
 * The distil batch-cache file (content-hash → digest; rebuildable, gitignored).
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute distil cache file path
 */
export function distilCachePath({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(cacheDir({ home }), "distil", "batches.json");
}
