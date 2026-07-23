/**
 * The member-bronze persistence edge: **redact → fingerprint-dedup → append JSONL**, one file per source
 * (`members/<source>.jsonl`). Mirrors the record-bronze discipline: redaction runs first so no secret hits
 * disk, and dedup keys on a fingerprint computed over everything EXCEPT `fetchedAtIso`, so re-hydrating an
 * unchanged member writes nothing (idempotent) while a genuine profile change appends a new row.
 *
 * Every filesystem call goes through a `safe*` wrapper (typed {@link ../../lib/ingestError.IngestError}).
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { slopweaverHome } from "../../config.js";
import { parseJsonObject } from "../../lib/jsonParse.js";
import { isOneOf, isRecord } from "../../lib/parsers.js";
import { err, ok, type Result } from "../../lib/result.js";
import { safeFs } from "../../lib/safeBoundary.js";
import { IDENTITY_SOURCES, type IdentitySource } from "../../silver/identity.js";
import { memberFile } from "../corpusPaths.js";
import { readMemberIdentity, readMemberProfile } from "./read.js";
import { redactMemberRow } from "./redact.js";
import type { MemberBronzeRow } from "./types.js";

/** The canonical JSONL serialisation of a member row (stable key order). Pure. */
export function serialiseMemberRow({ row }: { row: MemberBronzeRow }): string {
  return JSON.stringify({
    fetchedAtIso: row.fetchedAtIso,
    identity: row.identity,
    profile: row.profile,
    provenance: row.provenance,
    raw: row.raw,
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
  // A leaf primitive; `undefined` (which JSON.stringify would drop) maps to a stable sentinel so a missing
  // optional field never silently changes the fingerprint versus an explicit null.
  return value === undefined ? "null" : JSON.stringify(value);
}

/**
 * Content fingerprint = a CANONICAL (key-sorted) serialisation with `fetchedAtIso` blanked. Canonical so a
 * row read back off disk (whose curated `identity`/`profile` are reconstructed in a different key order)
 * still fingerprints identically to the freshly-hydrated row — otherwise a re-hydrate would never dedup. Pure.
 */
export function memberFingerprint({ row }: { row: MemberBronzeRow }): string {
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
export function freshMemberRows({
  incoming,
  stored,
}: {
  incoming: readonly MemberBronzeRow[];
  stored: readonly MemberBronzeRow[];
}): readonly MemberBronzeRow[] {
  const seen = new Set(stored.map((row) => memberFingerprint({ row })));
  const fresh: MemberBronzeRow[] = [];
  for (const row of incoming) {
    const fingerprint = memberFingerprint({ row });
    if (!seen.has(fingerprint)) {
      seen.add(fingerprint);
      fresh.push(row);
    }
  }
  return fresh;
}

/** A required non-empty string field off a raw object. Positional — used as a plain guard, not a predicate. */
function memberStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Parse one JSONL line back into a member row, or the reason it was rejected. Defensive — `version 1`, a
 * known `source`, and a non-empty `sourceId`/`identity`/`profile` are required; `raw` is kept verbatim. Pure.
 *
 * @param line one JSONL line
 * @returns the decoded row, or a rejection reason
 */
export function parseMemberRow({ line }: { line: string }): { row: MemberBronzeRow } | { error: string } {
  const parsed = parseJsonObject({ text: line });
  if (parsed.isErr()) {
    return { error: parsed.error };
  }
  const value = parsed.value;
  const source = value["source"];
  if (typeof source !== "string" || !isOneOf(source, IDENTITY_SOURCES)) {
    return { error: `unknown member source: ${String(source)}` };
  }
  const sourceId = memberStr({ value: value["sourceId"] });
  if (value["version"] !== 1 || sourceId === undefined || !isRecord(value["identity"]) || !isRecord(value["profile"])) {
    return { error: "missing required member field (version/sourceId/identity/profile)" };
  }
  return {
    row: {
      fetchedAtIso: typeof value["fetchedAtIso"] === "string" ? value["fetchedAtIso"] : "",
      identity: readMemberIdentity({ source, value: value["identity"] }),
      profile: readMemberProfile({ value: value["profile"] }),
      provenance: strArray({ value: value["provenance"] }),
      raw: value["raw"],
      source,
      sourceId,
      version: 1,
      warnings: strArray({ value: value["warnings"] }),
    },
  };
}

/** A string array off a raw field (non-strings dropped), else empty. Pure. */
function strArray({ value }: { value: unknown }): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/** Split JSONL content into rows + per-line warnings (a corrupt line is skipped, never fatal). Pure. */
export function parseMemberRows({ content }: { content: string }): {
  rows: readonly MemberBronzeRow[];
  warnings: readonly string[];
} {
  const rows: MemberBronzeRow[] = [];
  const warnings: string[] = [];
  content.split("\n").forEach((line, index) => {
    if (line.trim().length === 0) {
      return;
    }
    const result = parseMemberRow({ line });
    if ("row" in result) {
      rows.push(result.row);
    } else {
      warnings.push(`line ${String(index + 1)}: ${result.error}`);
    }
  });
  return { rows, warnings };
}

/** Read a source's stored member rows (absent file ⇒ empty, never a throw). */
export function readMemberRows({ source, home = slopweaverHome() }: { source: IdentitySource; home?: string }): {
  rows: readonly MemberBronzeRow[];
  warnings: readonly string[];
} {
  const path = memberFile({ home, source });
  const read = safeFs({ execute: () => readFileSync(path, "utf8"), operation: "readMemberRows", path });
  if (read.isErr()) {
    return read.error.code === "ENOENT" ? { rows: [], warnings: [] } : { rows: [], warnings: [read.error.message] };
  }
  return parseMemberRows({ content: read.value });
}

/** Read every source's stored member rows (for derive/identity — feeds the resolver + dossier). */
export function readAllMembers({ home = slopweaverHome() }: { home?: string } = {}): {
  rows: readonly MemberBronzeRow[];
  warnings: readonly string[];
} {
  const rows: MemberBronzeRow[] = [];
  const warnings: string[] = [];
  for (const source of IDENTITY_SOURCES) {
    const read = readMemberRows({ home, source });
    rows.push(...read.rows);
    warnings.push(...read.warnings.map((w) => `members/${source}.jsonl: ${w}`));
  }
  return { rows, warnings };
}

/** The member-write outcome (mirrors the record writer's shape). */
export interface MemberWriteResult {
  readonly written: number;
  readonly deduped: number;
}

/**
 * Redact, dedup against what's stored, and append the fresh rows to `members/<source>.jsonl`.
 *
 * @param source the identity source
 * @param rows the freshly-hydrated rows
 * @param home the world-model home (defaults to {@link slopweaverHome})
 * @returns the write stats, or a typed io error
 */
export function writeMemberRows({
  source,
  rows,
  home = slopweaverHome(),
}: {
  source: IdentitySource;
  rows: readonly MemberBronzeRow[];
  home?: string;
}): Result<MemberWriteResult> {
  const redacted = rows.map((row) => redactMemberRow({ row }));
  const stored = readMemberRows({ home, source }).rows;
  const fresh = freshMemberRows({ incoming: redacted, stored });
  if (fresh.length === 0) {
    return ok({ deduped: rows.length, written: 0 });
  }
  const path = memberFile({ home, source });
  const wrote = safeFs({
    execute: () => {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${fresh.map((row) => serialiseMemberRow({ row })).join("\n")}\n`, "utf8");
    },
    operation: "writeMemberRows",
    path,
  });
  return wrote.isErr()
    ? err([wrote.error.message])
    : ok({ deduped: rows.length - fresh.length, written: fresh.length });
}
