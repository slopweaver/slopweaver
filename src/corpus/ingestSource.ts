/**
 * Multi-source ingest orchestration: run each source's fetch+project job, then push its records through
 * the ONE bronze write path (redact → fingerprint-dedup → JSONL) and advance ONLY that source's
 * watermark — after its write succeeds. Sources are independent: one source failing never rolls back or
 * skips another's committed progress. Generic over `CorpusRecord`; no raw SDK shape leaks through here.
 */
import { ok, type Result } from "../lib/result.js";
import { writeCorpusRecords } from "./corpusWriter.js";
import type { CorpusRecord, CorpusSource, ExportWindow } from "./types.js";
import { advanceWatermark, computeSourceWatermarks } from "./watermark.js";

/** A watermark-advance outcome (the seam returns the repo `Result`; only its ok/errors shape the result). */
type AdvanceOutcome = Result<unknown>;

/** One source's ingest job: its window + a runner that fetches and projects records (or errors). */
export interface SourceIngestJob {
  readonly source: CorpusSource;
  readonly window: ExportWindow;
  readonly label: string;
  readonly run: () => Promise<
    Result<{ readonly records: readonly CorpusRecord[]; readonly warnings: readonly string[] }>
  >;
}

/** One source's ingest outcome — counts + any warnings/errors, so `refresh` can print a per-source summary. */
export interface SourceIngestResult {
  readonly source: CorpusSource;
  readonly ok: boolean;
  readonly projected: number;
  readonly written: number;
  readonly deduped: number;
  readonly warnings: readonly string[];
  readonly errors: readonly string[];
}

/** The fetch-failed result: nothing projected/written, the fetch errors surfaced. Pure. */
export function fetchFailureResult({
  source,
  errors,
}: {
  source: CorpusSource;
  errors: readonly string[];
}): SourceIngestResult {
  return { deduped: 0, errors, ok: false, projected: 0, source, warnings: [], written: 0 };
}

/**
 * The empty-but-successful-window result: nothing to write, but the watermark still advanced to `until`
 * (so the window isn't re-scanned) — its ok/errors flow through. Pure.
 */
export function emptyFetchResult({
  source,
  warnings,
  advanced,
}: {
  source: CorpusSource;
  warnings: readonly string[];
  advanced: AdvanceOutcome;
}): SourceIngestResult {
  return {
    deduped: 0,
    errors: advanced.ok ? [] : advanced.errors,
    ok: advanced.ok,
    projected: 0,
    source,
    warnings,
    written: 0,
  };
}

/** The write-failed result: records projected but the write errored, so the watermark did NOT advance. Pure. */
export function writeFailureResult({
  source,
  projected,
  warnings,
  errors,
}: {
  source: CorpusSource;
  projected: number;
  warnings: readonly string[];
  errors: readonly string[];
}): SourceIngestResult {
  return { deduped: 0, errors, ok: false, projected, source, warnings, written: 0 };
}

/**
 * The write-succeeded result: the write counts stand REGARDLESS of the subsequent watermark advance — a
 * watermark failure after a good write is surfaced (ok/errors) without losing the write counts. Pure.
 */
export function successfulIngestResult({
  source,
  projected,
  written,
  deduped,
  warnings,
  advanced,
}: {
  source: CorpusSource;
  projected: number;
  written: number;
  deduped: number;
  warnings: readonly string[];
  advanced: AdvanceOutcome;
}): SourceIngestResult {
  return { deduped, errors: advanced.ok ? [] : advanced.errors, ok: advanced.ok, projected, source, warnings, written };
}

/** The injected effectful seams (production: the real bronze writer + watermark store). */
export interface IngestDeps {
  readonly write: typeof writeCorpusRecords;
  readonly advance: typeof advanceWatermark;
}

const productionIngestDeps: IngestDeps = { advance: advanceWatermark, write: writeCorpusRecords };

/**
 * Run one job over injected seams: fetch/project → write that source's records → advance its watermark.
 * A thin shell composing the pure result builders; the write + watermark IO is injected for testing.
 */
async function ingestOneWithDeps({
  job,
  home,
  deps,
}: {
  job: SourceIngestJob;
  home: string;
  deps: IngestDeps;
}): Promise<SourceIngestResult> {
  const fetched = await job.run();
  if (fetched.ok === false) {
    return fetchFailureResult({ errors: fetched.errors, source: job.source });
  }
  const { records, warnings } = fetched.value;
  if (records.length === 0) {
    const advanced = deps.advance({ home, watermarks: [{ cursor: job.window.until, source: job.source }] });
    return emptyFetchResult({ advanced, source: job.source, warnings });
  }
  const written = deps.write({ home, records, window: job.window });
  if (written.ok === false) {
    return writeFailureResult({ errors: written.errors, projected: records.length, source: job.source, warnings });
  }
  const advanced = deps.advance({
    home,
    watermarks: computeSourceWatermarks({ fallbackUntil: job.window.until, records }),
  });
  return successfulIngestResult({
    advanced,
    deduped: written.value.deduped,
    projected: records.length,
    source: job.source,
    warnings,
    written: written.value.written,
  });
}

/** Per-source ingest progress, emitted as each source starts + finishes (non-blocking). */
export interface IngestProgress {
  readonly source: CorpusSource;
  readonly label: string;
  readonly phase: "start" | "done";
  readonly done: number;
  readonly total: number;
  readonly written?: number;
}

/**
 * Run every source job sequentially (bounded concurrency is a later, rate-limit-proven change),
 * committing each source's records + watermark independently. `onProgress` fires as each source starts
 * and finishes, so a long refresh is visible in the session (non-blocking).
 *
 * @param jobs the per-source ingest jobs
 * @param home the world-model home
 * @param onProgress optional per-source progress callback
 * @returns one result per job, in order
 */
export async function ingestSources({
  jobs,
  home,
  onProgress,
  deps = productionIngestDeps,
}: {
  jobs: readonly SourceIngestJob[];
  home: string;
  onProgress?: (progress: IngestProgress) => void;
  deps?: IngestDeps;
}): Promise<Result<readonly SourceIngestResult[]>> {
  const results: SourceIngestResult[] = [];
  const total = jobs.length;
  for (const [index, job] of jobs.entries()) {
    onProgress?.({ done: index, label: job.label, phase: "start", source: job.source, total });
    const result = await ingestOneWithDeps({ deps, home, job });
    results.push(result);
    onProgress?.({
      done: index + 1,
      label: job.label,
      phase: "done",
      source: job.source,
      total,
      written: result.written,
    });
  }
  return ok(results);
}
