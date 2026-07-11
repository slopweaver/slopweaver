/**
 * On-disk layout of the warehouse. One place that knows where bronze lines and the watermark live, so
 * the writer and reader can never disagree. v0.1 is warehouse-only — no legacy layout to tolerate.
 *
 *   $SLOPWEAVER_HOME/warehouse/
 *   ├── bronze/<source>/<since>_<until>.jsonl   # CorpusRecord lines
 *   ├── silver/index/{directory,opportunities,identities}.json
 *   ├── silver/graph/graph.json
 *   ├── silver/digests/<source>.json            # distilled per-source digests
 *   ├── gold/{overview,where-to-look}.md + gold/by-source/<source>.md
 *   ├── .cache/distil/batches.json              # content-hash digest cache (rebuildable)
 *   └── .watermark.json                         # per-source resume cursor
 */
import { join } from 'node:path'

import { slopweaverHome, warehouseDir } from '../config.js'
import type { CorpusSource, ExportWindow } from './types.js'

/**
 * The bronze root (all sources) under the home.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute bronze directory path
 */
export function bronzeDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(warehouseDir({ home }), 'bronze')
}

/**
 * The bronze dir for one source.
 *
 * @param source the corpus source
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute per-source bronze directory path
 */
export function bronzeSourceDir({ source, home = slopweaverHome() }: { source: CorpusSource; home?: string }): string {
  return join(bronzeDir({ home }), source)
}

/** Make an ISO/date string safe as a filename segment (`:` and `.` are illegal on some filesystems). */
function safeSegment({ value }: { value: string }): string {
  return value.replace(/[:.]/g, '-')
}

/**
 * The bronze JSONL file for one source + window.
 *
 * @param source the corpus source
 * @param window the export window
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute bronze JSONL file path
 */
export function bronzeFile(
  { source, window, home = slopweaverHome() }: { source: CorpusSource; window: ExportWindow; home?: string },
): string {
  const name = `${safeSegment({ value: window.since })}_${safeSegment({ value: window.until })}.jsonl`
  return join(bronzeSourceDir({ source, home }), name)
}

/**
 * The watermark file under the home.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute watermark file path
 */
export function watermarkPath({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(warehouseDir({ home }), '.watermark.json')
}

/**
 * The silver index dir (directory / opportunities / identities JSON).
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute silver index directory path
 */
export function silverIndexDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(warehouseDir({ home }), 'silver', 'index')
}

/**
 * The silver graph dir.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute silver graph directory path
 */
export function silverGraphDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(warehouseDir({ home }), 'silver', 'graph')
}

/**
 * The silver digests dir (per-source distilled digests).
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute silver digests directory path
 */
export function silverDigestsDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(warehouseDir({ home }), 'silver', 'digests')
}

/**
 * The gold markdown dir.
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute gold directory path
 */
export function goldDir({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(warehouseDir({ home }), 'gold')
}

/**
 * The distil batch-cache file (content-hash → digest; rebuildable, gitignored).
 *
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the absolute distil cache file path
 */
export function distilCachePath({ home = slopweaverHome() }: { home?: string } = {}): string {
  return join(warehouseDir({ home }), '.cache', 'distil', 'batches.json')
}
