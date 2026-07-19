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
