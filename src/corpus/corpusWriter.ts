/**
 * The bronze write pipeline: **redact → fingerprint-dedup → append JSONL**. Redaction runs first so no
 * secret ever touches disk (and so the fingerprint is computed over the exact bytes we persist). Dedup
 * is per `sourceId`: a record is written only when its content fingerprint is NEW for that id AND its
 * `tsIso` is at least the newest already stored — which makes refresh idempotent (re-running writes
 * nothing) and update-aware (a genuine edit writes a new line, a stale re-fetch does not).
 *
 * `serialiseRecord` fixes the key order and computes the fingerprint over everything EXCEPT `tsIso`, so
 * two captures of the same content at different times share a fingerprint and collapse.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { slopweaverHome } from "../config.js";
import { ok, type Result } from "../lib/result.js";
import { bronzeFile, bronzeSourceDir } from "./corpusPaths.js";
import { readCorpusDir } from "./corpusStore.js";
import { redactText } from "./redact.js";
import {
  CORPUS_SOURCES,
  type CorpusAttributeValue,
  type CorpusRecord,
  type CorpusSource,
  type ExportWindow,
} from "./types.js";

/** Attrs with keys in sorted order, so serialisation (and the fingerprint) is stable across runs. */
function orderedAttrs({
  attrs,
}: {
  attrs: Readonly<Record<string, CorpusAttributeValue>>;
}): Record<string, CorpusAttributeValue> {
  const out: Record<string, CorpusAttributeValue> = {};
  for (const key of Object.keys(attrs).toSorted()) {
    out[key] = attrs[key]!; // key came from Object.keys, so the value is present
  }
  return out;
}

/** Fixed-key-order object for a record; optional fields appended only when set (stable serialisation). */
function orderedRecord({ record }: { record: CorpusRecord }): Record<string, unknown> {
  const ordered: Record<string, unknown> = {
    container: record.container,
    kind: record.kind,
    refs: record.refs,
    source: record.source,
    sourceId: record.sourceId,
    text: record.text,
    tsIso: record.tsIso,
    url: record.url,
  };
  if (record.author !== undefined) {
    ordered["author"] = record.author;
  }
  if (record.title !== undefined) {
    ordered["title"] = record.title;
  }
  // `attrs` is appended last (after the v0.1 fields) and only when non-empty, so old readers/writers are
  // unaffected and the fingerprint changes only on a genuine metadata change.
  if (record.attrs !== undefined && Object.keys(record.attrs).length > 0) {
    ordered["attrs"] = orderedAttrs({ attrs: record.attrs });
  }
  // `raw` (the full source payload) is appended last of all. It is EXCLUDED from the fingerprint (see
  // `contentFingerprint`) so a volatile raw field never churns bronze — first-captured raw is retained.
  if (record.raw !== undefined && Object.keys(record.raw).length > 0) {
    ordered["raw"] = record.raw;
  }
  return ordered;
}

/**
 * The canonical JSONL serialisation of a record.
 *
 * @param record the record to serialise
 * @returns the JSON line (no trailing newline)
 */
export function serialiseRecord({ record }: { record: CorpusRecord }): string {
  return JSON.stringify(orderedRecord({ record }));
}

/**
 * Content fingerprint = the serialisation with `tsIso` blanked AND `raw` dropped, so neither a time-only
 * difference nor a volatile raw-payload field counts as a content change (either would needlessly churn
 * bronze). Dedup keys on the curated, meaningful content only.
 */
function contentFingerprint({ record }: { record: CorpusRecord }): string {
  const { raw: _raw, ...withoutRaw } = record;
  return serialiseRecord({ record: { ...withoutRaw, tsIso: "" } });
}

/** Redact string + string-array attr values (a secret can hide in metadata too); scalars pass through. */
function redactAttrs({
  attrs,
}: {
  attrs: Readonly<Record<string, CorpusAttributeValue>>;
}): Record<string, CorpusAttributeValue> {
  const out: Record<string, CorpusAttributeValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (typeof value === "string") {
      out[key] = redactText({ text: value }).text;
    } else if (Array.isArray(value)) {
      out[key] = value.map((item) => redactText({ text: item }).text);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * Recursively redact every string LEAF of a raw JSON value, preserving structure + all keys. A secret can
 * hide anywhere in the raw payload, so we scrub string substrings (email/token shapes) everywhere while
 * keeping every field — the whole point of raw retention. Non-strings (numbers/booleans/null) pass through.
 *
 * @param value any JSON value from a raw payload
 * @returns the same-shaped value with string leaves redacted
 */
function redactRawValue({ value }: { value: unknown }): unknown {
  if (typeof value === "string") {
    return redactText({ text: value }).text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactRawValue({ value: item }));
  }
  if (typeof value === "object" && value !== null) {
    return redactRawObject({ obj: value as Record<string, unknown> });
  }
  return value;
}

/** Redact every string leaf of a raw JSON OBJECT, returning the same-keyed object (typed, no cast at use). */
function redactRawObject({ obj }: { obj: Readonly<Record<string, unknown>> }): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, inner] of Object.entries(obj)) {
    out[key] = redactRawValue({ value: inner });
  }
  return out;
}

/**
 * Redact a record's free text (and title + string attrs + the raw payload); refs are structural, left intact.
 *
 * @param record the record to redact
 * @returns a new record with scrubbed text/title/attrs/raw
 */
export function redactRecord({ record }: { record: CorpusRecord }): CorpusRecord {
  return {
    ...record,
    text: redactText({ text: record.text }).text,
    ...(record.title !== undefined ? { title: redactText({ text: record.title }).text } : {}),
    ...(record.attrs !== undefined ? { attrs: redactAttrs({ attrs: record.attrs }) } : {}),
    ...(record.raw !== undefined ? { raw: redactRawObject({ obj: record.raw }) } : {}),
  };
}

interface StoredEntity {
  newestTs: string;
  readonly fingerprints: Set<string>;
}

/** Build the per-`sourceId` dedup index from whatever is already stored for a source. */
function storedIndex({ source, home }: { source: CorpusSource; home: string }): Map<string, StoredEntity> {
  const index = new Map<string, StoredEntity>();
  const stored = readCorpusDir({ dir: bronzeSourceDir({ home, source }) });
  for (const record of stored.ok ? stored.value : []) {
    const entity = index.get(record.sourceId) ?? { fingerprints: new Set<string>(), newestTs: "" };
    entity.fingerprints.add(contentFingerprint({ record }));
    if (record.tsIso > entity.newestTs) {
      entity.newestTs = record.tsIso;
    }
    index.set(record.sourceId, entity);
  }
  return index;
}

/** True when `record` should be written: new fingerprint for its id AND not older than what's stored. */
function isFresh({ record, index }: { record: CorpusRecord; index: Map<string, StoredEntity> }): boolean {
  const entity = index.get(record.sourceId);
  const fingerprint = contentFingerprint({ record });
  if (entity === undefined) {
    index.set(record.sourceId, { fingerprints: new Set([fingerprint]), newestTs: record.tsIso });
    return true;
  }
  if (entity.fingerprints.has(fingerprint) || record.tsIso < entity.newestTs) {
    return false;
  }
  entity.fingerprints.add(fingerprint);
  if (record.tsIso > entity.newestTs) {
    entity.newestTs = record.tsIso;
  }
  return true;
}

export interface WriteResult {
  readonly written: number;
  readonly deduped: number;
  readonly bySource: Readonly<Record<string, number>>;
}

/**
 * Redact, dedup, and append the fresh records to their per-source window file.
 *
 * @param records the records to persist
 * @param window the export window (names the target file)
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the write stats: `written` (new lines), `deduped` (collapsed inputs), `bySource`
 */
export function writeCorpusRecords({
  records,
  window,
  home = slopweaverHome(),
}: {
  records: readonly CorpusRecord[];
  window: ExportWindow;
  home?: string;
}): Result<WriteResult> {
  const redacted = records.map((record) => redactRecord({ record }));
  const bySource: Record<string, number> = {};
  let written = 0;

  for (const source of CORPUS_SOURCES) {
    const bucket = redacted.filter((record) => record.source === source);
    if (bucket.length === 0) {
      continue;
    }
    const index = storedIndex({ home, source });
    const fresh = bucket.filter((record) => isFresh({ index, record }));
    if (fresh.length === 0) {
      continue;
    }
    const file = bronzeFile({ home, source, window });
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${fresh.map((record) => serialiseRecord({ record })).join("\n")}\n`, "utf8");
    bySource[source] = fresh.length;
    written += fresh.length;
  }

  return ok({ bySource, deduped: records.length - written, written });
}
