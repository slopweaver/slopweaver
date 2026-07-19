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

/** Run one job: fetch/project → write that source's records → advance its watermark. */
async function ingestOne({ job, home }: { job: SourceIngestJob; home: string }): Promise<SourceIngestResult> {
  const fetched = await job.run();
  if (fetched.ok === false) {
    return {
      deduped: 0,
      errors: fetched.errors,
      ok: false,
      projected: 0,
      source: job.source,
      warnings: [],
      written: 0,
    };
  }
  const { records, warnings } = fetched.value;
  if (records.length === 0) {
    // A successful empty window still advances the watermark to `until` so we don't re-scan it next run.
    const advanced = advanceWatermark({ home, watermarks: [{ cursor: job.window.until, source: job.source }] });
    return {
      deduped: 0,
      errors: advanced.ok ? [] : advanced.errors,
      ok: advanced.ok,
      projected: 0,
      source: job.source,
      warnings,
      written: 0,
    };
  }
  const written = writeCorpusRecords({ home, records, window: job.window });
  if (written.ok === false) {
    return {
      deduped: 0,
      errors: written.errors,
      ok: false,
      projected: records.length,
      source: job.source,
      warnings,
      written: 0,
    };
  }
  const advanced = advanceWatermark({
    home,
    watermarks: computeSourceWatermarks({ fallbackUntil: job.window.until, records }),
  });
  return {
    deduped: written.value.deduped,
    errors: advanced.ok ? [] : advanced.errors,
    ok: advanced.ok,
    projected: records.length,
    source: job.source,
    warnings,
    written: written.value.written,
  };
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
}: {
  jobs: readonly SourceIngestJob[];
  home: string;
  onProgress?: (progress: IngestProgress) => void;
}): Promise<Result<readonly SourceIngestResult[]>> {
  const results: SourceIngestResult[] = [];
  const total = jobs.length;
  for (const [index, job] of jobs.entries()) {
    onProgress?.({ done: index, label: job.label, phase: "start", source: job.source, total });
    const result = await ingestOne({ home, job });
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
