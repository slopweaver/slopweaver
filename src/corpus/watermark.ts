/**
 * The per-source watermark: the max `tsIso` we've ever observed for a source, so the next refresh
 * resumes from there instead of re-scanning history. It's the max OBSERVED timestamp, deliberately not
 * the window's `until` — advancing to `until` would skip any records that land later with an earlier
 * timestamp (a gap). Merge is MAX at the leaf, so a narrower re-run can never move a cursor backwards.
 * Writes are atomic (tmp + rename) so a crash mid-write can't corrupt the cursor.
 *
 * Each source's cursor lives in its OWN file (`corpus/watermarks/<source>.json`) rather than one shared
 * `.watermark.json`. That's what makes concurrent per-source refreshes safe: two sources finishing at the
 * same moment write DIFFERENT files, so neither can clobber the other's cursor (a single shared file's
 * read-modify-write would). The legacy combined `.watermark.json` is still READ as a migration fallback,
 * so a home written before the split keeps resuming.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { slopweaverHome } from "../config.js";
import { isRecord } from "../lib/parsers.js";
import { err, ok, type Result } from "../lib/result.js";
import { sourceWatermarkPath, watermarkPath } from "./corpusPaths.js";
import { type CorpusSource, type SourceWatermark } from "./types.js";

/**
 * Max observed `tsIso` per source. Sources with no records are omitted; `fallbackUntil` fills a gap
 * only when a source's records all carry an empty `tsIso`.
 *
 * @param records the just-written records (only `source` + `tsIso` are read)
 * @param fallbackUntil the window `until`, used only when a source has no non-empty `tsIso`
 * @returns one watermark per source seen
 */
export function computeSourceWatermarks({
  records,
  fallbackUntil,
}: {
  records: readonly { source: CorpusSource; tsIso: string }[];
  fallbackUntil: string;
}): readonly SourceWatermark[] {
  const maxBySource = new Map<CorpusSource, string>();
  const seenSources = new Set<CorpusSource>();
  for (const { source, tsIso } of records) {
    seenSources.add(source);
    const currentMax = maxBySource.get(source);
    if (tsIso.length > 0 && (currentMax === undefined || tsIso > currentMax)) {
      maxBySource.set(source, tsIso);
    }
  }
  return [...seenSources].map((source) => ({ cursor: maxBySource.get(source) ?? fallbackUntil, source }));
}

/** The `cursor` string from a validated `{ cursor }` object, or undefined. Pure. */
function cursorOf({ raw }: { raw: unknown }): string | undefined {
  return isRecord(raw) && typeof raw["cursor"] === "string" ? raw["cursor"] : undefined;
}

/** Read a source's cursor from its OWN file (`corpus/watermarks/<source>.json`); missing/invalid ⇒ undefined. */
function readSourceFile({ home, source }: { home: string; source: CorpusSource }): string | undefined {
  try {
    return cursorOf({ raw: JSON.parse(readFileSync(sourceWatermarkPath({ home, source }), "utf8")) });
  } catch {
    return undefined; // no per-source file yet (or unreadable) — the caller falls back to the legacy file
  }
}

/** Read a source's cursor from the LEGACY combined `.watermark.json` (migration for pre-split homes). */
function readLegacyCursor({ home, source }: { home: string; source: CorpusSource }): string | undefined {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(watermarkPath({ home }), "utf8"));
  } catch {
    return undefined;
  }
  const sources = isRecord(raw) ? raw["sources"] : undefined;
  return isRecord(sources) ? cursorOf({ raw: sources[source] }) : undefined;
}

/**
 * The stored cursor for a source, if any — its own per-source file wins, else the legacy combined file
 * (so a home written before the per-source split still resumes). Pure-ish (reads two candidate files).
 *
 * @param source the corpus source
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the stored cursor, or undefined when none
 */
export function readWatermark({
  source,
  home = slopweaverHome(),
}: {
  source: CorpusSource;
  home?: string;
}): string | undefined {
  return readSourceFile({ home, source }) ?? readLegacyCursor({ home, source });
}

/**
 * Pick the export `since`: the stored cursor (sliced to a date), else the fallback.
 *
 * @param cursor the stored cursor, if any
 * @param fallbackSince the since to use when there's no cursor
 * @returns the resolved since date
 */
export function resolveSince({ cursor, fallbackSince }: { cursor: string | undefined; fallbackSince: string }): string {
  return cursor !== undefined && cursor.length > 0 ? cursor.slice(0, 10) : fallbackSince;
}

/** Write ONE source's cursor to its own file atomically (tmp + rename). */
function writeSourceFile({
  home,
  source,
  cursor,
}: {
  home: string;
  source: CorpusSource;
  cursor: string;
}): Result<{ path: string }> {
  const path = sourceWatermarkPath({ home, source });
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ cursor, version: 1 }, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
  } catch (error: unknown) {
    return err([error instanceof Error ? error.message : `failed to write watermark ${path}`]);
  }
  return ok({ path });
}

/**
 * Advance each source's cursor (MAX-merged against its stored value, so a narrower re-run never rewinds),
 * writing each to its OWN file. Because sources write separate files, two concurrent per-source refreshes
 * can't clobber each other. Written atomically per file.
 *
 * @param watermarks the per-source cursors to merge in
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the written per-source paths, or an error on any write failure
 */
export function advanceWatermark({
  watermarks,
  home = slopweaverHome(),
}: {
  watermarks: readonly SourceWatermark[];
  home?: string;
}): Result<{ paths: readonly string[] }> {
  const paths: string[] = [];
  const errors: string[] = [];
  for (const { source, cursor } of watermarks) {
    const existing = readWatermark({ home, source }); // MAX-merge: keep the later of stored vs incoming
    const next = existing !== undefined && existing > cursor ? existing : cursor;
    const written = writeSourceFile({ cursor: next, home, source });
    if (written.ok) {
      paths.push(written.value.path);
    } else {
      errors.push(...written.errors);
    }
  }
  return errors.length > 0 ? err(errors) : ok({ paths });
}
