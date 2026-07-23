/**
 * Structure-specific redaction. A structure row's org identifiers (repo/team/channel names) are the whole
 * point of the capture and are kept verbatim — structure bronze lives off-repo under `$SLOPWEAVER_HOME`, and
 * the public leak gate scans the repo, not the home. What IS scrubbed is the secret CLASSES (tokens, long
 * digit runs) that can hide inside a raw payload's string leaves — via {@link redactSecrets}, recursively —
 * so a stray access token or signed-URL query never lands on disk. Mirrors the member-bronze discipline.
 */
import { isRecord } from "../../lib/parsers.js";
import { redactSecrets } from "../redact.js";
import type { AttrValue, StructureBronzeRow } from "./types.js";

/**
 * Recursively scrub secret classes from every string LEAF of a raw JSON value, preserving structure + keys.
 * Non-strings pass through. Pure.
 *
 * @param value any JSON value from a raw structure payload
 * @returns the same-shaped value with token/number leaves scrubbed
 */
export function redactStructureRawValue({ value }: { value: unknown }): unknown {
  if (typeof value === "string") {
    return redactSecrets({ text: value }).text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStructureRawValue({ value: item }));
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = redactStructureRawValue({ value: inner });
    }
    return out;
  }
  return value;
}

/** Scrub one curated attr value's string content (a string, or a string-array; other scalars pass through). Pure. */
function redactAttrValue({ value }: { value: AttrValue }): AttrValue {
  if (typeof value === "string") {
    return redactSecrets({ text: value }).text;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets({ text: item }).text);
  }
  return value;
}

/** Scrub the curated attrs map's free-text string values. Pure. */
function redactAttrs({ attrs }: { attrs: Readonly<Record<string, AttrValue>> }): Readonly<Record<string, AttrValue>> {
  const out: Record<string, AttrValue> = {};
  for (const [key, value] of Object.entries(attrs)) {
    out[key] = redactAttrValue({ value });
  }
  return out;
}

/**
 * Scrub a structure row before it is written: the raw payload's string leaves + the curated free-text attrs
 * are secret-scrubbed. The identity name/slug/url are org-scaffolding display fields, kept intact. Pure.
 *
 * @param row the structure row to scrub
 * @returns a new row with secret classes removed, org identifiers preserved
 */
export function redactStructureRow({ row }: { row: StructureBronzeRow }): StructureBronzeRow {
  return {
    ...row,
    attrs: redactAttrs({ attrs: row.attrs }),
    raw: redactStructureRawValue({ value: row.raw }),
  };
}
