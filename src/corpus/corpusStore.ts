/**
 * The fail-closed corpus reader. Reads bronze JSONL back into `CorpusRecord[]`, and is deliberately
 * conservative in three ways:
 *
 *  1. A corrupt line (bad JSON, wrong shape, missing required field) is SKIPPED with a line-numbered
 *     warning — one bad line never aborts the read, but it's never silently swallowed either.
 *  2. A missing directory reads as `ok([])` **with a warning**, so a mistyped path looks like "no data",
 *     not a crash — but `resolveCorpusDir` (below) refuses to hand out a dir that doesn't exist or holds
 *     no `.jsonl`, closing the "wrong path looked empty" footgun before a reader ever gets there.
 *  3. Only records whose `source`/`kind` are in the known unions survive; anything else is dropped.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { isErrno, isOneOf, isRecord } from "../lib/parsers.js";
import { err, ok, type Result } from "../lib/result.js";
import { bronzeDir } from "./corpusPaths.js";
import { CORPUS_KINDS, CORPUS_SOURCES, type CorpusAttributeValue, type CorpusRecord } from "./types.js";

/** Type guard: a non-empty string. Positional — TS1230 forbids destructuring in a type predicate. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** A valid attr value: a scalar or a string array. Positional — used as a type predicate. */
function isAttributeValue(value: unknown): value is CorpusAttributeValue {
  return (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    (Array.isArray(value) && value.every((item) => typeof item === "string"))
  );
}

/**
 * Parse the optional `attrs` field defensively: keep only well-typed entries, drop the rest. A malformed
 * `attrs` (or a bad entry) NEVER drops the record — rich metadata is best-effort, the record is not.
 *
 * @param value the raw `attrs` value from a parsed row
 * @returns the valid attrs (undefined when absent or nothing valid survives)
 */
function parseAttrs({ value }: { value: unknown }): Readonly<Record<string, CorpusAttributeValue>> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: Record<string, CorpusAttributeValue> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isAttributeValue(raw)) {
      out[key] = raw;
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Parse one JSONL line into a record, or return an error string describing why it was rejected. */
function parseRow({ line }: { line: string }): { record: CorpusRecord } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return { error: "invalid JSON" };
  }
  if (!isRecord(parsed)) {
    return { error: "not a JSON object" };
  }
  const { source, sourceId, url, tsIso, kind, container, text, refs, author, title, attrs, raw } = parsed;
  if (typeof source !== "string" || !isOneOf(source, CORPUS_SOURCES)) {
    return { error: `unknown source: ${String(source)}` };
  }
  if (typeof kind !== "string" || !isOneOf(kind, CORPUS_KINDS)) {
    return { error: `unknown kind: ${String(kind)}` };
  }
  if (
    !isNonEmptyString(sourceId) ||
    !isNonEmptyString(tsIso) ||
    !isNonEmptyString(container) ||
    !isNonEmptyString(text)
  ) {
    return { error: "missing required field (sourceId/tsIso/container/text)" };
  }
  if (typeof url !== "string") {
    return { error: "url must be a string" };
  }
  if (!Array.isArray(refs) || !refs.every((r) => typeof r === "string")) {
    return { error: "refs must be a string array" };
  }
  const parsedAttrs = parseAttrs({ value: attrs });
  // `raw` is the opaque full source payload — kept verbatim (never field-validated), dropped only if it
  // isn't an object. A malformed raw never drops the record.
  const parsedRaw = isRecord(raw) ? raw : undefined;
  return {
    record: {
      container,
      kind,
      refs,
      source,
      sourceId,
      text,
      tsIso,
      url,
      ...(isNonEmptyString(author) ? { author } : {}),
      ...(isNonEmptyString(title) ? { title } : {}),
      ...(parsedAttrs !== undefined ? { attrs: parsedAttrs } : {}),
      ...(parsedRaw !== undefined ? { raw: parsedRaw } : {}),
    },
  };
}

/**
 * Parse JSONL content into records. Corrupt lines are skipped and surfaced as warnings, never fatal.
 *
 * @param content the raw JSONL text
 * @returns the parsed records (always `ok`; rejected lines become warnings)
 */
export function parseCorpusRecords({ content }: { content: string }): Result<readonly CorpusRecord[]> {
  const records: CorpusRecord[] = [];
  const warnings: string[] = [];
  content.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }
    const result = parseRow({ line });
    if ("record" in result) {
      records.push(result.record);
    } else {
      warnings.push(`line ${String(index + 1)}: ${result.error}`);
    }
  });
  return ok(records, warnings);
}

/** Every `.jsonl` file under `dir`, recursively. */
function jsonlFiles({ dir }: { dir: string }): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...jsonlFiles({ dir: full }));
    } else if (entry.endsWith(".jsonl")) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Read every record under a corpus dir (recursing source subdirs). Missing dir ⇒ `ok([])` + warning.
 *
 * @param dir the directory to read
 * @returns the records, with a warning per corrupt line or a treated-as-empty missing dir
 */
export function readCorpusDir({ dir }: { dir: string }): Result<readonly CorpusRecord[]> {
  let exists = false;
  try {
    exists = statSync(dir).isDirectory();
  } catch (error: unknown) {
    if (isErrno(error) && error.code === "ENOENT") {
      return ok([], [`corpus dir not found (treated as empty): ${dir}`]);
    }
    return err([error instanceof Error ? error.message : `failed to stat ${dir}`]);
  }
  if (!exists) {
    return ok([], [`not a directory (treated as empty): ${dir}`]);
  }
  const records: CorpusRecord[] = [];
  const warnings: string[] = [];
  for (const file of jsonlFiles({ dir })) {
    const parsed = parseCorpusRecords({ content: readFileSync(file, "utf8") });
    if (parsed.ok) {
      records.push(...parsed.value);
      warnings.push(...parsed.warnings.map((w) => `${file}: ${w}`));
    }
  }
  return ok(records, warnings);
}

/** Count `.jsonl` files under `dir` (0 when the dir is absent). */
function countJsonlFiles({ dir }: { dir: string }): number {
  return jsonlFiles({ dir }).length;
}

/**
 * Resolve a readable corpus dir. `corpus` (an explicit dir) is used verbatim; otherwise the bronze dir
 * under `home`. Either way it must exist and hold ≥1 `.jsonl`, else `err` — so a wrong path fails loudly
 * instead of masquerading as an empty corpus.
 *
 * @param home the world-model home (used when `corpus` is absent)
 * @param corpus an explicit corpus directory override
 * @returns the resolved dir, or an error when it's absent/empty
 */
export function resolveCorpusDir({ home, corpus }: { home?: string; corpus?: string }): Result<string> {
  const dir = corpus ?? (home !== undefined ? bronzeDir({ home }) : bronzeDir({}));
  if (countJsonlFiles({ dir }) === 0) {
    return err([`no corpus found at ${dir} — run \`slopweaver refresh\` first`]);
  }
  return ok(dir);
}
