/**
 * Pure Notion curated-layer extractors (PR4.3): turn already-fetched raw payloads into the explicit
 * relation edges + ref-only file metadata the curated graph consumes. No I/O — everything here reads the
 * raw objects `fetch.ts` already pulled, so it is fully unit-testable.
 *
 *  - **Relation targets** — a `relation` property's target page ids, as `notion:page:<id>` node keys (so a
 *    relation renders as a real edge, not the old lossy "N linked"). The target TITLE is deliberately NOT
 *    looked up live (that would be an N+1 per target); it is joined later from the local crawl if present.
 *  - **Mentions** — rich-text `mention` spans that carry a CONCRETE target id (page/database/user). This is
 *    EXPLICIT-tag only: a mention span is a structured object with an id, never a fuzzy name/nickname text
 *    match (see the identity-exact-match-only rule).
 *  - **File refs** — `file`/`image`/`pdf`/`video`/`audio`/`embed` blocks + `files` properties, kept as
 *    metadata only (type + name + a STABLE url). A Notion-hosted `file.url` is a signed, expiring URL and is
 *    NEVER persisted; only an author-provided `external`/`embed` url survives.
 */
import { isRecord } from "../../lib/parsers.js";

/** File-bearing block/media types whose refs we keep (metadata only). */
const FILE_BLOCK_TYPES: ReadonlySet<string> = new Set(["file", "image", "pdf", "video", "audio", "embed"]);

/** De-dupe a string list, first-seen order. Pure. */
function dedupe({ values }: { values: readonly string[] }): readonly string[] {
  return [...new Set(values.filter((v) => v.length > 0))];
}

/**
 * The `notion:page:<id>` target node keys of every `relation` property on a row/page. Pure.
 *
 * @param properties the raw `properties` object
 * @returns the deduped target node keys (empty when none)
 */
export function extractRelationTargets({ properties }: { properties: unknown }): readonly string[] {
  if (!isRecord(properties)) {
    return [];
  }
  const targets: string[] = [];
  for (const value of Object.values(properties)) {
    if (!isRecord(value) || value["type"] !== "relation" || !Array.isArray(value["relation"])) {
      continue;
    }
    for (const rel of value["relation"]) {
      if (isRecord(rel) && typeof rel["id"] === "string" && rel["id"].length > 0) {
        targets.push(`notion:page:${rel["id"]}`);
      }
    }
  }
  return dedupe({ values: targets });
}

/** The target node key for one rich-text `mention` object (page/database/user), or undefined. Pure. */
function mentionNode({ mention }: { mention: Record<string, unknown> }): string | undefined {
  const type = typeof mention["type"] === "string" ? mention["type"] : undefined;
  const target = type !== undefined ? mention[type] : undefined;
  if (type === undefined || !isRecord(target) || typeof target["id"] !== "string" || target["id"].length === 0) {
    return undefined;
  }
  if (type === "page" || type === "database" || type === "user") {
    return `notion:${type}:${target["id"]}`;
  }
  return undefined; // date / link_preview / template mentions carry no record target
}

/**
 * The explicit mention target node keys in a `rich_text` array (page/database/user spans only). Pure —
 * EXPLICIT-tag only: a `mention` span is a structured id, never a fuzzy name match.
 *
 * @param richText the raw `rich_text` array
 * @returns the deduped mention target node keys
 */
export function extractMentions({ richText }: { richText: unknown }): readonly string[] {
  if (!Array.isArray(richText)) {
    return [];
  }
  const targets: string[] = [];
  for (const span of richText) {
    if (isRecord(span) && span["type"] === "mention" && isRecord(span["mention"])) {
      const node = mentionNode({ mention: span["mention"] });
      if (node !== undefined) {
        targets.push(node);
      }
    }
  }
  return dedupe({ values: targets });
}

/** A stable, non-expiring url for a file body — an author-provided `external`/`embed` url only. Pure. */
function stableFileUrl({ body }: { body: Record<string, unknown> }): string | undefined {
  const external = body["external"];
  if (isRecord(external) && typeof external["url"] === "string" && external["url"].length > 0) {
    return external["url"];
  }
  // An embed block carries its url directly; a Notion-hosted `file.url` is signed/expiring — never kept.
  if (body["type"] === undefined && typeof body["url"] === "string" && body["url"].length > 0) {
    return body["url"];
  }
  return undefined;
}

/** The display name of a file body (`name`, else empty). Pure. */
function fileName({ body }: { body: Record<string, unknown> }): string {
  return typeof body["name"] === "string" ? body["name"] : "";
}

/** Format one ref-only file line, or undefined when it carries neither a name nor a stable url. Pure. */
function formatFileRef({ type, name, url }: { type: string; name: string; url?: string }): string | undefined {
  if (name.length === 0 && url === undefined) {
    return undefined; // an internal-only file with no name — nothing safe/useful to keep
  }
  const label = name.length > 0 ? `${type}: ${name}` : type;
  return url !== undefined ? `${label} (${url})` : label;
}

/** The ref-only file line for a media block (`file`/`image`/`pdf`/`video`/`audio`/`embed`), or undefined. Pure. */
export function blockFileRef({ block }: { block: Record<string, unknown> }): string | undefined {
  const type = typeof block["type"] === "string" ? block["type"] : undefined;
  const body = type !== undefined ? block[type] : undefined;
  if (type === undefined || !FILE_BLOCK_TYPES.has(type) || !isRecord(body)) {
    return undefined;
  }
  const url = stableFileUrl({ body });
  return formatFileRef({ name: fileName({ body }), type, ...(url !== undefined ? { url } : {}) });
}

/** One `files`-property entry → its ref-only line (never a signed URL), or undefined. Pure. */
function filePropertyRef({ file }: { file: unknown }): string | undefined {
  if (!isRecord(file)) {
    return undefined;
  }
  const url = stableFileUrl({ body: file });
  return formatFileRef({ name: fileName({ body: file }), type: "file", ...(url !== undefined ? { url } : {}) });
}

/** The ref-only file lines from every `files`-typed property on a row/page. Pure. */
export function extractFilePropertyRefs({ properties }: { properties: unknown }): readonly string[] {
  if (!isRecord(properties)) {
    return [];
  }
  const refs: string[] = [];
  for (const value of Object.values(properties)) {
    if (!isRecord(value) || value["type"] !== "files" || !Array.isArray(value["files"])) {
      continue;
    }
    for (const file of value["files"]) {
      const ref = filePropertyRef({ file });
      if (ref !== undefined) {
        refs.push(ref);
      }
    }
  }
  return dedupe({ values: refs });
}
