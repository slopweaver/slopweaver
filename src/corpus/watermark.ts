/**
 * The per-source watermark: the max `tsIso` we've ever observed for a source, so the next refresh
 * resumes from there instead of re-scanning history. It's the max OBSERVED timestamp, deliberately not
 * the window's `until` — advancing to `until` would skip any records that land later with an earlier
 * timestamp (a gap). Merge is MAX at the leaf, so a narrower re-run can never move a cursor backwards.
 * Writes are atomic (tmp + rename) so a crash mid-write can't corrupt the cursor.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import { isRecord } from '../lib/parsers.js'
import { err, ok, type Result } from '../lib/result.js'
import { slopweaverHome } from '../config.js'
import { watermarkPath } from './corpusPaths.js'
import { type CorpusSource, type SourceWatermark } from './types.js'

interface WatermarkFile {
  readonly version: 1
  readonly sources: Partial<Record<CorpusSource, { readonly cursor: string }>>
}

const EMPTY: WatermarkFile = { version: 1, sources: {} }

/**
 * Max observed `tsIso` per source. Sources with no records are omitted; `fallbackUntil` fills a gap
 * only when a source's records all carry an empty `tsIso`.
 *
 * @param records the just-written records (only `source` + `tsIso` are read)
 * @param fallbackUntil the window `until`, used only when a source has no non-empty `tsIso`
 * @returns one watermark per source seen
 */
export function computeSourceWatermarks(
  { records, fallbackUntil }: { records: readonly { source: CorpusSource; tsIso: string }[]; fallbackUntil: string },
): readonly SourceWatermark[] {
  const maxBySource = new Map<CorpusSource, string>()
  const seenSources = new Set<CorpusSource>()
  for (const { source, tsIso } of records) {
    seenSources.add(source)
    if (tsIso.length > 0 && tsIso > (maxBySource.get(source) ?? '')) {
      maxBySource.set(source, tsIso)
    }
  }
  return [...seenSources].map((source) => ({ source, cursor: maxBySource.get(source) ?? fallbackUntil }))
}

/** Read + validate the watermark file; anything unrecognised degrades to an empty watermark. */
function readWatermarkFile({ home }: { home: string }): WatermarkFile {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(watermarkPath({ home }), 'utf8'))
  } catch {
    return EMPTY
  }
  if (!isRecord(raw) || !isRecord(raw.sources)) {
    return EMPTY
  }
  const sources: Partial<Record<CorpusSource, { cursor: string }>> = {}
  for (const [key, value] of Object.entries(raw.sources)) {
    if (isRecord(value) && typeof value.cursor === 'string') {
      sources[key as CorpusSource] = { cursor: value.cursor }
    }
  }
  return { version: 1, sources }
}

/**
 * The stored cursor for a source, if any.
 *
 * @param source the corpus source
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the stored cursor, or undefined when none
 */
export function readWatermark({ source, home = slopweaverHome() }: { source: CorpusSource; home?: string }): string | undefined {
  return readWatermarkFile({ home }).sources[source]?.cursor
}

/**
 * Pick the export `since`: the stored cursor (sliced to a date), else the fallback.
 *
 * @param cursor the stored cursor, if any
 * @param fallbackSince the since to use when there's no cursor
 * @returns the resolved since date
 */
export function resolveSince({ cursor, fallbackSince }: { cursor: string | undefined; fallbackSince: string }): string {
  return cursor !== undefined && cursor.length > 0 ? cursor.slice(0, 10) : fallbackSince
}

/** Merge incoming watermarks into the current file, MAX at every source cursor. */
function mergeWatermark(
  { current, incoming }: { current: WatermarkFile; incoming: readonly SourceWatermark[] },
): WatermarkFile {
  const sources = { ...current.sources }
  for (const { source, cursor } of incoming) {
    const existing = sources[source]?.cursor ?? ''
    if (cursor > existing) {
      sources[source] = { cursor }
    }
  }
  return { version: 1, sources }
}

/**
 * Advance the watermark file to include `watermarks` (MAX-merged), written atomically.
 *
 * @param watermarks the per-source cursors to merge in
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the written path, or an error on write failure
 */
export function advanceWatermark(
  { watermarks, home = slopweaverHome() }: { watermarks: readonly SourceWatermark[]; home?: string },
): Result<{ path: string }> {
  const path = watermarkPath({ home })
  const merged = mergeWatermark({ current: readWatermarkFile({ home }), incoming: watermarks })
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
    renameSync(tmp, path)
  } catch (error: unknown) {
    return err([error instanceof Error ? error.message : `failed to write watermark ${path}`])
  }
  return ok({ path })
}
