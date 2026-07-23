/**
 * The structure-bronze persistence edge: **redact → fingerprint-dedup → append JSONL**, one file per source
 * (`structures/<source>.jsonl`). Mirrors the member-bronze discipline: redaction runs first so no secret hits
 * disk, and dedup keys on a fingerprint computed over everything EXCEPT `fetchedAtIso`, so re-hydrating an
 * unchanged entity writes nothing (idempotent) while a genuine change (a renamed channel, a new team member)
 * appends a new row. Every filesystem call goes through a `safe*` wrapper (typed {@link ../../lib/ingestError.IngestError}).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { slopweaverHome } from "../../config.js";
import { parseJsonObject } from "../../lib/jsonParse.js";
import { isOneOf, isRecord } from "../../lib/parsers.js";
import { err, ok, type Result } from "../../lib/result.js";
import { safeFs } from "../../lib/safeBoundary.js";
import { IDENTITY_SOURCES, type IdentitySource } from "../../silver/identity.js";
import { structureFile } from "../corpusPaths.js";
import { readAttrs, readRelations, readStrArray, readStructureIdentity, STRUCTURE_KINDS } from "./read.js";
import { redactStructureRow } from "./redact.js";
import type { StructureBronzeRow, StructureKind } from "./types.js";

/** The canonical JSONL serialisation of a structure row (stable key order). Pure. */
export function serialiseStructureRow({ row }: { row: StructureBronzeRow }): string {
  return JSON.stringify({
    attrs: row.attrs,
    fetchedAtIso: row.fetchedAtIso,
    identity: row.identity,
    kind: row.kind,
    provenance: row.provenance,
    raw: row.raw,
    relations: row.relations,
    source: row.source,
    sourceId: row.sourceId,
    version: row.version,
    warnings: row.warnings,
  });
}

/** A canonical (recursively key-sorted) JSON string of any value — so key ORDER never affects equality. Pure. */
function stableStringify({ value }: { value: unknown }): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify({ value: item })).join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${stableStringify({ value: value[key] })}`);
    return `{${entries.join(",")}}`;
  }
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * Content fingerprint = a CANONICAL (key-sorted) serialisation with `fetchedAtIso` blanked. Canonical so a
 * row read back off disk still fingerprints identically to the freshly-hydrated row — otherwise a re-hydrate
 * would never dedup. Pure.
 */
export function structureFingerprint({ row }: { row: StructureBronzeRow }): string {
  return stableStringify({ value: { ...row, fetchedAtIso: "" } });
}

/**
 * The subset of incoming rows worth writing — a NEW fingerprint versus what's already stored AND versus
 * earlier incoming rows (so a within-batch dup collapses too). Pure.
 *
 * @param incoming the freshly-hydrated rows
 * @param stored the rows already on disk for this source
 * @returns the rows to append, in input order
 */
export function freshStructureRows({
  incoming,
  stored,
}: {
  incoming: readonly StructureBronzeRow[];
  stored: readonly StructureBronzeRow[];
}): readonly StructureBronzeRow[] {
  const seen = new Set(stored.map((row) => structureFingerprint({ row })));
  const fresh: StructureBronzeRow[] = [];
  for (const row of incoming) {
    const fingerprint = structureFingerprint({ row });
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      fresh.push(row);
    }
  }
  return fresh;
}

/** A required non-empty string field off a raw object. Positional — used as a plain guard, not a predicate. */
function structureStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse one JSONL line back into a structure row, or the reason it was rejected. Defensive — `version 1`, a
 * known `source` + `kind`, and a non-empty `sourceId` are required; `raw` is kept verbatim. Pure.
 *
 * @param line one JSONL line
 * @returns the decoded row, or a rejection reason
 */
export function parseStructureRow({ line }: { line: string }): { row: StructureBronzeRow } | { error: string } {
  const parsed = parseJsonObject({ text: line });
  if (parsed.isErr()) {
    return { error: parsed.error };
  }
  const value = parsed.value;
  const source = value["source"];
  if (typeof source !== "string" || !isOneOf(source, IDENTITY_SOURCES)) {
    return { error: `unknown structure source: ${String(source)}` };
  }
  const kind = value["kind"];
  if (typeof kind !== "string" || !isOneOf(kind, STRUCTURE_KINDS)) {
    return { error: `unknown structure kind: ${String(kind)}` };
  }
  const sourceId = structureStr({ value: value["sourceId"] });
  if (value["version"] !== 1 || sourceId === undefined) {
    return { error: "missing required structure field (version/sourceId)" };
  }
  return { row: decodeStructureRow({ kind, source, sourceId, value }) };
}

/** Build a validated {@link StructureBronzeRow} from a parsed line's already-checked scalars. Pure. */
function decodeStructureRow({
  value,
  source,
  kind,
  sourceId,
}: {
  value: Record<string, unknown>;
  source: IdentitySource;
  kind: StructureKind;
  sourceId: string;
}): StructureBronzeRow {
  return {
    attrs: readAttrs({ value: value["attrs"] }),
    fetchedAtIso: typeof value["fetchedAtIso"] === "string" ? value["fetchedAtIso"] : "",
    identity: readStructureIdentity({ value: value["identity"] }),
    kind,
    provenance: readStrArray({ value: value["provenance"] }),
    raw: value["raw"],
    relations: readRelations({ value: value["relations"] }),
    source,
    sourceId,
    version: 1,
    warnings: readStrArray({ value: value["warnings"] }),
  };
}

/** Split JSONL content into rows + per-line warnings (a corrupt line is skipped, never fatal). Pure. */
export function parseStructureRows({ content }: { content: string }): {
  rows: readonly StructureBronzeRow[];
  warnings: readonly string[];
} {
  const rows: StructureBronzeRow[] = [];
  const warnings: string[] = [];
  content.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }
    const result = parseStructureRow({ line });
    if ("row" in result) {
      rows.push(result.row);
    } else {
      warnings.push(`line ${String(index + 1)}: ${result.error}`);
    }
  });
  return { rows, warnings };
}

/** Read a source's stored structure rows (absent file ⇒ empty, never a throw). */
export function readStructureRows({ source, home = slopweaverHome() }: { source: IdentitySource; home?: string }): {
  rows: readonly StructureBronzeRow[];
  warnings: readonly string[];
} {
  const path = structureFile({ home, source });
  const read = safeFs({ execute: () => readFileSync(path, "utf8"), operation: "readStructureRows", path });
  if (read.isErr()) {
    return read.error.code === "ENOENT" ? { rows: [], warnings: [] } : { rows: [], warnings: [read.error.message] };
  }
  return parseStructureRows({ content: read.value });
}

/** Read every source's stored structure rows (for derive — feeds the silver directory/graph). */
export function readAllStructures({ home = slopweaverHome() }: { home?: string } = {}): {
  rows: readonly StructureBronzeRow[];
  warnings: readonly string[];
} {
  const rows: StructureBronzeRow[] = [];
  const warnings: string[] = [];
  for (const source of IDENTITY_SOURCES) {
    const read = readStructureRows({ home, source });
    rows.push(...read.rows);
    warnings.push(...read.warnings.map((w) => `structures/${source}.jsonl: ${w}`));
  }
  return { rows, warnings };
}

/** The structure-write outcome (mirrors the member writer's shape). */
export interface StructureWriteResult {
  readonly written: number;
  readonly deduped: number;
}

/**
 * Redact, dedup against what's stored, and append the fresh rows to `structures/<source>.jsonl`.
 *
 * @param source the identity source
 * @param rows the freshly-hydrated rows
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the write stats, or a typed io error
 */
export function writeStructureRows({
  source,
  rows,
  home = slopweaverHome(),
}: {
  source: IdentitySource;
  rows: readonly StructureBronzeRow[];
  home?: string;
}): Result<StructureWriteResult> {
  const redacted = rows.map((row) => redactStructureRow({ row }));
  const stored = readStructureRows({ home, source }).rows;
  const fresh = freshStructureRows({ incoming: redacted, stored });
  if (fresh.length === 0) {
    return ok({ deduped: rows.length, written: 0 });
  }
  const path = structureFile({ home, source });
  const wrote = safeFs({
    execute: () => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${fresh.map((row) => serialiseStructureRow({ row })).join("\n")}\n`, "utf8");
    },
    operation: "writeStructureRows",
    path,
  });
  return wrote.isErr()
    ? err([wrote.error.message])
    : ok({ deduped: rows.length - fresh.length, written: fresh.length });
}
