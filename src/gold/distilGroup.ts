/**
 * Group the corpus into distil batches — one LLM call's worth of records, bucketed by
 * `source + container` and chunked. Pure, deterministic. Each batch carries a **content hash**
 * (`sha256(source+container + each record's sourceId+text).slice(0,16)`) that is the cache key: it
 * changes iff the batch's records change, so a re-run only re-calls the model for changed batches.
 */
import { createHash } from "node:crypto";

import type { CorpusRecord, CorpusSource } from "../corpus/types.js";

export const DEFAULT_MAX_PER_BATCH = 40;

export interface DistilBatch {
  readonly source: CorpusSource;
  readonly container: string;
  readonly records: readonly CorpusRecord[];
  readonly hash: string;
}

/** The content hash for a batch of records (the cache key). */
function hashBatch({
  source,
  container,
  records,
}: {
  source: CorpusSource;
  container: string;
  records: readonly CorpusRecord[];
}): string {
  const hash = createHash("sha256");
  hash.update(`${source} ${container}`);
  for (const record of records) {
    hash.update(` ${record.sourceId} ${record.text}`);
  }
  return hash.digest("hex").slice(0, 16);
}

/** Newest-first within a container: `tsIso` desc, `sourceId` asc tiebreak. */
function byRecency({ a, b }: { a: CorpusRecord; b: CorpusRecord }): number {
  return a.tsIso < b.tsIso
    ? 1
    : a.tsIso > b.tsIso
      ? -1
      : a.sourceId < b.sourceId
        ? -1
        : a.sourceId > b.sourceId
          ? 1
          : 0;
}

/** Keep only the busiest `n` containers per source (drops the low-signal long tail). */
function keepTopContainers({
  buckets,
  n,
}: {
  buckets: Map<string, CorpusRecord[]>;
  n: number;
}): Map<string, CorpusRecord[]> {
  const bySource = new Map<CorpusSource, { key: string; records: CorpusRecord[] }[]>();
  for (const [key, records] of buckets) {
    const source = records[0]?.source ?? "github";
    const list = bySource.get(source) ?? [];
    list.push({ key, records });
    bySource.set(source, list);
  }
  const kept = new Map<string, CorpusRecord[]>();
  for (const list of bySource.values()) {
    list.sort((x, y) => y.records.length - x.records.length || (x.key < y.key ? -1 : 1));
    for (const { key, records } of list.slice(0, n)) {
      kept.set(key, records);
    }
  }
  return kept;
}

function chunk<T>({ items, size }: { items: readonly T[]; size: number }): readonly (readonly T[])[] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Group records into distil batches.
 *
 * @param records the corpus records
 * @param maxPerBatch max records per batch (default {@link DEFAULT_MAX_PER_BATCH})
 * @param topContainersPerSource keep only the busiest N containers per source (optional)
 * @param recentOnly take only the newest `maxPerBatch` records per container as one batch (bounded first run)
 * @returns the batches, sorted by `source container`
 */
export function groupForDistil({
  records,
  maxPerBatch = DEFAULT_MAX_PER_BATCH,
  topContainersPerSource,
  recentOnly = false,
}: {
  records: readonly CorpusRecord[];
  maxPerBatch?: number;
  topContainersPerSource?: number;
  recentOnly?: boolean;
}): readonly DistilBatch[] {
  const buckets = new Map<string, CorpusRecord[]>();
  for (const record of records) {
    const key = `${record.source} ${record.container}`;
    const bucket = buckets.get(key) ?? [];
    bucket.push(record);
    buckets.set(key, bucket);
  }
  const scoped =
    topContainersPerSource !== undefined ? keepTopContainers({ buckets, n: topContainersPerSource }) : buckets;

  const batches: DistilBatch[] = [];
  for (const key of [...scoped.keys()].toSorted()) {
    const bucket = [...(scoped.get(key) ?? [])].toSorted((a, b) => byRecency({ a, b }));
    if (bucket.length === 0) {
      continue;
    }
    const first = bucket[0]!; // bucket.length !== 0 checked above ⇒ in-bounds
    const source = first.source;
    const container = first.container;
    const slices = recentOnly ? [bucket.slice(0, maxPerBatch)] : chunk({ items: bucket, size: maxPerBatch });
    for (const slice of slices) {
      if (slice.length > 0) {
        batches.push({ container, hash: hashBatch({ container, records: slice, source }), records: slice, source });
      }
    }
  }
  return batches;
}
