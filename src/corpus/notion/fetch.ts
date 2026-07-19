/**
 * The impure Notion edge. Discovers accessible pages + databases via `search`, recursively pages each
 * page's block children, renders rich text to plain text (links preserved), chunks long pages into
 * stable sections, and pulls comments — shaping into the clean items `project.ts` consumes. The
 * `@notionhq/client` `Client` is confined here behind an injected `NotionApi` seam so the paging
 * orchestration is unit-testable with a fake. `chunkText` + `renderRichText` are pure + separately
 * tested. File/image mentions are kept as reference text only; expiring signed URLs are never persisted.
 */
import { Client } from "@notionhq/client";

import { isRecord } from "../../lib/parsers.js";
import { createRateScheduler, retryTransient } from "../../lib/resilience.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import type { ExportWindow } from "../types.js";
import type { NotionCommentItem, NotionDatabaseItem, NotionPageItem } from "./project.js";

/** A rate-gated + transient-retried request runner — one shared per crawl (see {@link makeNotionApi}). */
type GatedCall = <T>(task: () => Promise<T>) => Promise<T>;

const PAGE_SIZE = 100;
const MAX_CHUNK_CHARS = 1500;
const MAX_BLOCK_DEPTH = 6;
/** Notion's documented all-tier ceiling; the shared rate scheduler sits just under it. */
const NOTION_RATE_PER_SEC = 3;

/** A page of shaped pages from the seam. `nextCursor` absent ⇒ the `since` cutoff was reached (stop). */
export interface NotionPagesPage {
  readonly pages: readonly NotionPageItem[];
  readonly nextCursor?: string;
  readonly warnings?: readonly string[];
}

/** A page of shaped databases from the seam. `nextCursor` absent ⇒ the `since` cutoff was reached.
 * `rows` carries each discovered data source's ROW pages (the actual records), projected as pages. */
export interface NotionDatabasesPage {
  readonly databases: readonly NotionDatabaseItem[];
  readonly rows: readonly NotionPageItem[];
  readonly nextCursor?: string;
}

/** Injected Notion seam — returns fully-shaped items so tests need no live SDK. */
export interface NotionApi {
  pages: (args: { since: string; cursor?: string }) => Promise<NotionPagesPage>;
  databases: (args: { since: string; cursor?: string }) => Promise<NotionDatabasesPage>;
}

/**
 * Split rendered page text into stable ~`maxChars` section chunks on paragraph boundaries, so a long
 * doc becomes several retrievable records rather than one giant atom. Pure + deterministic.
 *
 * @param text the full rendered page text
 * @param maxChars the soft chunk size (defaults to the module cap)
 * @returns the ordered chunks (empty input ⇒ no chunks)
 */
export function chunkText({
  text,
  maxChars = MAX_CHUNK_CHARS,
}: {
  text: string;
  maxChars?: number;
}): readonly string[] {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return [];
  }
  const paragraphs = trimmed.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`;
    if (candidate.length > maxChars && current.length > 0) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    chunks.push(current);
  }
  return chunks;
}

/**
 * Render a Notion `rich_text` array to plain text, preserving link targets as `text (url)`. Pure.
 *
 * @param richText the raw `rich_text` array (defensively parsed)
 * @returns the rendered plain text
 */
export function renderRichText({ richText }: { richText: unknown }): string {
  if (!Array.isArray(richText)) {
    return "";
  }
  return richText
    .map((span) => {
      if (!isRecord(span)) {
        return "";
      }
      const content = typeof span["plain_text"] === "string" ? span["plain_text"] : "";
      const href = typeof span["href"] === "string" && span["href"].length > 0 ? span["href"] : undefined;
      return href !== undefined ? `${content} (${href})` : content;
    })
    .join("");
}

/** Comma-join the `.name`s of an array of `{name}` objects (multi_select / people). */
function namesOf({ field }: { field: unknown }): string {
  if (!Array.isArray(field)) {
    return "";
  }
  return field
    .map((item) => (isRecord(item) && typeof item["name"] === "string" ? item["name"] : ""))
    .filter((name) => name.length > 0)
    .join(", ");
}

/** Render a Notion `date` property (`start` and optional `end`). */
function dateText({ field }: { field: unknown }): string {
  if (!isRecord(field) || typeof field["start"] !== "string") {
    return "";
  }
  return typeof field["end"] === "string" ? `${field["start"]} → ${field["end"]}` : field["start"];
}

/**
 * Render one Notion property value to plain text, dispatched on its `type` (title/rich_text/select/
 * status/multi_select/number/checkbox/date/url/email/phone_number/people/relation). Pure.
 *
 * @param value the raw property value object (defensively parsed)
 * @returns the rendered text, or empty for an unknown/empty property
 */
export function renderProperty({ value }: { value: unknown }): string {
  if (!isRecord(value) || typeof value["type"] !== "string") {
    return "";
  }
  const type = value["type"];
  const field = value[type];
  if (type === "title" || type === "rich_text") {
    return renderRichText({ richText: field });
  }
  if (type === "select" || type === "status") {
    return isRecord(field) && typeof field["name"] === "string" ? field["name"] : "";
  }
  if (type === "multi_select" || type === "people") {
    return namesOf({ field });
  }
  if (type === "number") {
    return typeof field === "number" ? String(field) : "";
  }
  if (type === "checkbox") {
    return field === true ? "yes" : "";
  }
  if (type === "date") {
    return dateText({ field });
  }
  if (type === "url" || type === "email" || type === "phone_number") {
    return typeof field === "string" ? field : "";
  }
  if (type === "relation") {
    return Array.isArray(field) ? `${String(field.length)} linked` : "";
  }
  return "";
}

/**
 * Flatten a data-source row's `properties` into a title + a `Name: value` text block. Pure — this is
 * what makes a row (a task/decision record) retrievable, not just a database summary.
 *
 * @param properties the raw row `properties` object
 * @returns the row title (the title-typed property) + the rendered property lines
 */
export function renderRowProperties({ properties }: { properties: unknown }): { title: string; text: string } {
  if (!isRecord(properties)) {
    return { text: "", title: "" };
  }
  let title = "";
  const lines: string[] = [];
  for (const [name, value] of Object.entries(properties)) {
    const rendered = renderProperty({ value });
    if (isRecord(value) && value["type"] === "title") {
      title = rendered;
    }
    if (rendered.length > 0) {
      lines.push(`${name}: ${rendered}`);
    }
  }
  return { text: lines.join("\n"), title };
}

/**
 * Fetch shaped Notion activity — accessible pages (recursively rendered + chunked) and databases — over
 * the window, paging each lane until the seam stops returning a cursor (which the live seam does once the
 * `since` cutoff is reached, since Notion search has no server-side date filter). Top-level failure is
 * fatal; per-page comment-fetch failures surface as warnings.
 *
 * @param api the injected Notion seam
 * @param window the export window (`since` bounds `last_edited_time`, applied client-side by the seam)
 * @returns the shaped pages + databases + warnings, or `err` on a fatal failure
 */
export async function fetchNotionActivity({
  api,
  window,
}: {
  api: NotionApi;
  window: ExportWindow;
}): Promise<
  Result<{ pages: readonly NotionPageItem[]; databases: readonly NotionDatabaseItem[]; warnings: readonly string[] }>
> {
  const pages: NotionPageItem[] = [];
  const databases: NotionDatabaseItem[] = [];
  const warnings: string[] = [];
  try {
    let pageCursor: string | undefined;
    do {
      const page = await api.pages({
        since: window.since,
        ...(pageCursor !== undefined ? { cursor: pageCursor } : {}),
      });
      pages.push(...page.pages);
      if (page.warnings !== undefined) {
        warnings.push(...page.warnings);
      }
      pageCursor = page.nextCursor;
    } while (pageCursor !== undefined && pageCursor.length > 0);

    let dbCursor: string | undefined;
    do {
      const page = await api.databases({
        since: window.since,
        ...(dbCursor !== undefined ? { cursor: dbCursor } : {}),
      });
      databases.push(...page.databases);
      pages.push(...page.rows); // data-source ROWS are the actual records — projected as pages
      dbCursor = page.nextCursor;
    } while (dbCursor !== undefined && dbCursor.length > 0);
  } catch (error: unknown) {
    return err([`fetch failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  return ok({ databases, pages, warnings });
}

/** Best-effort title from a page/database `properties` object or `title` array. */
function titleFrom({ raw }: { raw: Record<string, unknown> }): string {
  if (Array.isArray(raw["title"])) {
    return renderRichText({ richText: raw["title"] });
  }
  const properties = raw["properties"];
  if (isRecord(properties)) {
    for (const value of Object.values(properties)) {
      if (isRecord(value) && value["type"] === "title") {
        return renderRichText({ richText: value["title"] });
      }
    }
  }
  return "(untitled)";
}

/** Recursively render a page's block children to plain text, bounded by depth. Every call is rate-gated. */
async function renderBlocks({
  client,
  call,
  blockId,
  depth,
}: {
  client: Client;
  call: GatedCall;
  blockId: string;
  depth: number;
}): Promise<string> {
  if (depth > MAX_BLOCK_DEPTH) {
    return "";
  }
  const lines: string[] = [];
  let cursor: string | undefined;
  do {
    const res = orThrow({
      result: await safeApiCall({
        execute: () =>
          call(() =>
            client.blocks.children.list({
              block_id: blockId,
              page_size: PAGE_SIZE,
              ...(cursor !== undefined ? { start_cursor: cursor } : {}),
            }),
          ),
        operation: "notion.blocks.children.list",
        provider: "notion",
      }),
    });
    for (const result of res.results) {
      const block: unknown = result;
      if (!isRecord(block)) {
        continue;
      }
      const type = typeof block["type"] === "string" ? block["type"] : undefined;
      const body = type !== undefined ? block[type] : undefined;
      if (isRecord(body)) {
        lines.push(renderRichText({ richText: body["rich_text"] }));
      }
      if (block["has_children"] === true && typeof block["id"] === "string") {
        lines.push(await renderBlocks({ blockId: block["id"], call, client, depth: depth + 1 }));
      }
    }
    cursor = typeof res.next_cursor === "string" && res.next_cursor.length > 0 ? res.next_cursor : undefined;
  } while (cursor !== undefined);
  return lines.filter((line) => line.length > 0).join("\n\n");
}

/** The `since` cutoff in epoch-ms, or undefined when `since` means "no cutoff" (the `--all` epoch date). */
export function cutoffMs({ since }: { since: string }): number | undefined {
  if (since <= "1970-01-01") {
    return undefined;
  }
  const ms = Date.parse(`${since}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Whether a result's `last_edited_time` is at/after the cutoff (undated or no-cutoff ⇒ keep). */
export function withinCutoff({ lastEdited, cutoff }: { lastEdited: string; cutoff: number | undefined }): boolean {
  if (cutoff === undefined) {
    return true;
  }
  const ms = Date.parse(lastEdited);
  return Number.isFinite(ms) ? ms >= cutoff : true;
}

/** Fetch a page's comments, paged to exhaustion (rate-gated). A comments-scope gap warns, never fails. */
async function pageComments({
  client,
  call,
  pageId,
}: {
  client: Client;
  call: GatedCall;
  pageId: string;
}): Promise<{ comments: readonly NotionCommentItem[]; warnings: readonly string[] }> {
  const comments: NotionCommentItem[] = [];
  let cursor: string | undefined;
  try {
    do {
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            call(() =>
              client.comments.list({
                block_id: pageId,
                ...(cursor !== undefined ? { start_cursor: cursor } : {}),
              }),
            ),
          operation: "notion.comments.list",
          provider: "notion",
        }),
      });
      for (const result of res.results) {
        const comment = projectCommentItem({ raw: result });
        if (comment !== undefined) {
          comments.push(comment);
        }
      }
      cursor = typeof res.next_cursor === "string" && res.next_cursor.length > 0 ? res.next_cursor : undefined;
    } while (cursor !== undefined);
  } catch (error: unknown) {
    return {
      comments,
      warnings: [`comments for page ${pageId} failed: ${error instanceof Error ? error.message : "unknown"}`],
    };
  }
  return { comments, warnings: [] };
}

/** Query a data source's rows (the actual task/decision records) to exhaustion, rate-gated, cutoff-honoured. */
async function dataSourceRows({
  client,
  call,
  dataSourceId,
  cutoff,
}: {
  client: Client;
  call: GatedCall;
  dataSourceId: string;
  cutoff: number | undefined;
}): Promise<readonly NotionPageItem[]> {
  const rows: NotionPageItem[] = [];
  let cursor: string | undefined;
  for (;;) {
    const res = orThrow({
      result: await safeApiCall({
        execute: () =>
          call(() =>
            client.dataSources.query({
              data_source_id: dataSourceId,
              page_size: PAGE_SIZE,
              ...(cursor !== undefined ? { start_cursor: cursor } : {}),
            }),
          ),
        operation: "notion.dataSources.query",
        provider: "notion",
      }),
    });
    for (const result of res.results) {
      const raw: unknown = result;
      if (!isRecord(raw) || typeof raw["id"] !== "string") {
        continue;
      }
      const lastEdited = lastEditedOf({ raw });
      if (!withinCutoff({ cutoff, lastEdited })) {
        continue; // rows aren't ordered — filter, don't stop paging
      }
      rows.push(projectRowItem({ dataSourceId, id: raw["id"], lastEdited, raw }));
    }
    const next = typeof res.next_cursor === "string" && res.next_cursor.length > 0 ? res.next_cursor : undefined;
    if (next === undefined) {
      return rows;
    }
    cursor = next;
  }
}

/** The `last_edited_time` of a raw Notion object (empty when absent). Pure. */
export function lastEditedOf({ raw }: { raw: Record<string, unknown> }): string {
  return typeof raw["last_edited_time"] === "string" ? raw["last_edited_time"] : "";
}

/** Project a raw Notion `data_source` search hit into a database summary item (title + url). Pure. */
export function projectDatabaseItem({
  raw,
  id,
  lastEdited,
}: {
  raw: Record<string, unknown>;
  id: string;
  lastEdited: string;
}): NotionDatabaseItem {
  return {
    description: "",
    id,
    raw,
    title: titleFrom({ raw }),
    tsIso: lastEdited,
    url: typeof raw["url"] === "string" ? raw["url"] : "",
  };
}

/** Project a raw Notion page into a page item (its rendered text chunked, comments attached). Pure. */
export function projectPageItem({
  raw,
  id,
  lastEdited,
  text,
  comments,
}: {
  raw: Record<string, unknown>;
  id: string;
  lastEdited: string;
  text: string;
  comments: readonly NotionCommentItem[];
}): NotionPageItem {
  return {
    chunks: chunkText({ text }),
    comments,
    id,
    raw,
    title: titleFrom({ raw }),
    tsIso: lastEdited,
    url: typeof raw["url"] === "string" ? raw["url"] : "",
  };
}

/** Project a raw data-source ROW into a page item (its properties flattened + chunked). Pure. */
export function projectRowItem({
  raw,
  id,
  dataSourceId,
  lastEdited,
}: {
  raw: Record<string, unknown>;
  id: string;
  dataSourceId: string;
  lastEdited: string;
}): NotionPageItem {
  const { title, text } = renderRowProperties({ properties: raw["properties"] });
  return {
    chunks: chunkText({ text }),
    comments: [],
    id,
    parent: dataSourceId,
    raw,
    title: title.length > 0 ? title : "(row)",
    tsIso: lastEdited,
    url: typeof raw["url"] === "string" ? raw["url"] : "",
  };
}

/** Project a raw Notion comment into a comment item (its rich text rendered). Pure; undefined if id-less. */
export function projectCommentItem({ raw }: { raw: unknown }): NotionCommentItem | undefined {
  if (!isRecord(raw) || typeof raw["id"] !== "string") {
    return undefined;
  }
  return {
    body: renderRichText({ richText: raw["rich_text"] }),
    id: raw["id"],
    raw,
    tsIso: typeof raw["created_time"] === "string" ? raw["created_time"] : "",
  };
}

/**
 * Build the production Notion seam over a live `Client`. Search discovery, recursive block rendering,
 * chunking, comment fetches, AND data-source row queries — every call gated through ONE shared rate
 * scheduler (~3 req/s) + transient retry so a big recursive crawl never self-429s.
 *
 * @param token the Notion integration token
 * @returns the live Notion seam
 */
export function makeNotionApi({ token }: { token: string }): NotionApi {
  const client = new Client({ auth: token });
  const gate = createRateScheduler({ ratePerSec: NOTION_RATE_PER_SEC });
  // One shared runner: transient-retried AND rate-paced. Retry is OUTSIDE the gate so each attempt (incl. a
  // post-429 retry) re-acquires a rate slot — gating only the first try would let retries burst past the cap.
  const call: GatedCall = (task) => retryTransient({ operation: () => gate(task) });
  // Notion `search` has no server-side date filter, so we sort by `last_edited_time` DESCENDING and stop
  // paging once a result older than `since` appears (all subsequent are older). `--all` ⇒ no cutoff.
  const SORT_NEWEST_FIRST = { direction: "descending", timestamp: "last_edited_time" } as const;
  const nextOf = ({
    nextCursor,
    reachedCutoff,
  }: {
    nextCursor: string | null;
    reachedCutoff: boolean;
  }): string | undefined =>
    !reachedCutoff && typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : undefined;

  return {
    databases: async ({ since, cursor }) => {
      const cutoff = cutoffMs({ since });
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            call(() =>
              client.search({
                filter: { property: "object", value: "data_source" },
                page_size: PAGE_SIZE,
                sort: SORT_NEWEST_FIRST,
                ...(cursor !== undefined ? { start_cursor: cursor } : {}),
              }),
            ),
          operation: "notion.search.databases",
          provider: "notion",
        }),
      });
      const databases: NotionDatabaseItem[] = [];
      const rows: NotionPageItem[] = [];
      let reachedCutoff = false;
      for (const result of res.results) {
        const raw: unknown = result;
        if (!isRecord(raw) || typeof raw["id"] !== "string") {
          continue;
        }
        const lastEdited = lastEditedOf({ raw });
        if (!withinCutoff({ cutoff, lastEdited })) {
          reachedCutoff = true;
          break;
        }
        databases.push(projectDatabaseItem({ id: raw["id"], lastEdited, raw }));
        rows.push(...(await dataSourceRows({ call, client, cutoff, dataSourceId: raw["id"] })));
      }
      const next = nextOf({ nextCursor: res.next_cursor, reachedCutoff });
      return { databases, rows, ...(next !== undefined ? { nextCursor: next } : {}) };
    },
    pages: async ({ since, cursor }) => {
      const cutoff = cutoffMs({ since });
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            call(() =>
              client.search({
                filter: { property: "object", value: "page" },
                page_size: PAGE_SIZE,
                sort: SORT_NEWEST_FIRST,
                ...(cursor !== undefined ? { start_cursor: cursor } : {}),
              }),
            ),
          operation: "notion.search.pages",
          provider: "notion",
        }),
      });
      const pages: NotionPageItem[] = [];
      const warnings: string[] = [];
      let reachedCutoff = false;
      for (const result of res.results) {
        const raw: unknown = result;
        if (!isRecord(raw) || typeof raw["id"] !== "string") {
          continue;
        }
        const lastEdited = lastEditedOf({ raw });
        if (!withinCutoff({ cutoff, lastEdited })) {
          reachedCutoff = true;
          break;
        }
        const id = raw["id"];
        const text = await renderBlocks({ blockId: id, call, client, depth: 0 });
        const comments = await pageComments({ call, client, pageId: id });
        warnings.push(...comments.warnings);
        pages.push(projectPageItem({ comments: comments.comments, id, lastEdited, raw, text }));
      }
      const next = nextOf({ nextCursor: res.next_cursor, reachedCutoff });
      return {
        pages,
        ...(next !== undefined ? { nextCursor: next } : {}),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    },
  };
}
