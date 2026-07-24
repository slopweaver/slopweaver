/**
 * The impure Notion edge. Discovers accessible pages + databases via `search`, recursively pages each
 * page's block children, renders rich text to plain text (links preserved), chunks long pages into
 * stable sections, and pulls comments — shaping into the clean items `project.ts` consumes. The
 * `@notionhq/client` `Client` is confined here behind an injected `NotionApi` seam so the paging
 * orchestration is unit-testable with a fake. `chunkText` + `renderRichText` are pure + separately
 * tested. File/image mentions are kept as reference text only; expiring signed URLs are never persisted.
 */
import { Client } from "@notionhq/client";

import { parseIsoMs, parseYyyyMmDdUtcMs } from "../../lib/date.js";
import { isRecord } from "../../lib/parsers.js";
import { createRateScheduler, retryTransient } from "../../lib/resilience.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import { buildMemberIdentity, finaliseMemberTrust } from "../members/email.js";
import { aggregateMemberWarnings } from "../members/project.js";
import type { MemberBronzeRow } from "../members/types.js";
import { type SourceProgress, type SourceProgressEvent, sourceHeartbeat, sourcePreview } from "../progress.js";
import type { ExportWindow } from "../types.js";
import { blockFileRef, extractFilePropertyRefs, extractMentions, extractRelationTargets } from "./curated.js";
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
  readonly warnings?: readonly string[];
}

/** A page of raw Notion user objects from `users.list` (projected to member rows by {@link fetchNotionMembers}). */
export interface NotionUsersPage {
  readonly results: readonly unknown[];
  readonly nextCursor?: string;
}

/** Injected Notion seam — returns fully-shaped items so tests need no live SDK. */
export interface NotionApi {
  pages: (args: { since: string; cursor?: string }) => Promise<NotionPagesPage>;
  databases: (args: { since: string; cursor?: string }) => Promise<NotionDatabasesPage>;
  users: (args: { cursor?: string }) => Promise<NotionUsersPage>;
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

/** Render a rich-text-typed field (title / rich_text). */
function renderRichTextField({ field }: { field: unknown }): string {
  return renderRichText({ richText: field });
}

/** Render a `{name}`-typed field (select / status). */
function renderNameField({ field }: { field: unknown }): string {
  return isRecord(field) && typeof field["name"] === "string" ? field["name"] : "";
}

/** Render a scalar-string field (url / email / phone_number). */
function renderStringField({ field }: { field: unknown }): string {
  return typeof field === "string" ? field : "";
}

/** Render a number field. */
function renderNumberField({ field }: { field: unknown }): string {
  return typeof field === "number" ? String(field) : "";
}

/** Render a checkbox field (`true` ⇒ "yes"). */
function renderCheckboxField({ field }: { field: unknown }): string {
  return field === true ? "yes" : "";
}

/** Render a relation field as a linked-count. */
function renderRelationField({ field }: { field: unknown }): string {
  return Array.isArray(field) ? `${String(field.length)} linked` : "";
}

/** The property-type → renderer dispatch table (replaces the old if-chain; keeps behaviour identical). */
const PROPERTY_RENDERERS: Readonly<Record<string, (args: { field: unknown }) => string>> = {
  checkbox: renderCheckboxField,
  date: (args) => dateText({ field: args.field }),
  email: renderStringField,
  multi_select: (args) => namesOf({ field: args.field }),
  number: renderNumberField,
  people: (args) => namesOf({ field: args.field }),
  phone_number: renderStringField,
  relation: renderRelationField,
  rich_text: renderRichTextField,
  select: renderNameField,
  status: renderNameField,
  title: renderRichTextField,
  url: renderStringField,
};

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
  const renderer = PROPERTY_RENDERERS[type];
  return renderer !== undefined ? renderer({ field: value[type] }) : "";
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
  onProgress,
}: {
  api: NotionApi;
  window: ExportWindow;
  onProgress?: SourceProgress;
}): Promise<
  Result<{ pages: readonly NotionPageItem[]; databases: readonly NotionDatabaseItem[]; warnings: readonly string[] }>
> {
  try {
    const pageLane = await pageAllPages({
      api,
      since: window.since,
      ...(onProgress !== undefined ? { onProgress } : {}),
    });
    const dbLane = await pageAllDatabases({
      api,
      since: window.since,
      ...(onProgress !== undefined ? { onProgress } : {}),
    });
    // data-source ROWS are the actual records — projected as pages (appended after the discovered pages).
    return ok({
      databases: dbLane.databases,
      pages: [...pageLane.pages, ...dbLane.rows],
      warnings: [...pageLane.warnings, ...dbLane.warnings],
    });
  } catch (error: unknown) {
    return err([`fetch failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
}

/** A content-preview from a Notion page (its title + first rendered chunk). Pure. */
export function notionPagePreview({ page }: { page: NotionPageItem }): SourceProgressEvent {
  return sourcePreview({
    phase: "pages",
    snippet: page.chunks[0] ?? page.title,
    source: "notion",
    sourceContentId: page.id,
    subject: page.title,
  });
}

/** A content-preview from a Notion database (its title). Pure. */
export function notionDatabasePreview({ database }: { database: NotionDatabaseItem }): SourceProgressEvent {
  return sourcePreview({
    phase: "databases",
    snippet: database.title,
    source: "notion",
    sourceContentId: database.id,
    subject: database.title,
  });
}

/** Page the `pages` lane to exhaustion, collecting shaped pages + per-page comment warnings + heartbeats. */
async function pageAllPages({
  api,
  since,
  onProgress,
}: {
  api: NotionApi;
  since: string;
  onProgress?: SourceProgress;
}): Promise<{ pages: readonly NotionPageItem[]; warnings: readonly string[] }> {
  const pages: NotionPageItem[] = [];
  const warnings: string[] = [];
  let cursor: string | undefined;
  let index = 0;
  do {
    const page = await api.pages({ since, ...(cursor !== undefined ? { cursor } : {}) });
    if (index === 0 && page.pages[0] !== undefined) {
      onProgress?.(notionPagePreview({ page: page.pages[0] }));
    }
    pages.push(...page.pages);
    if (page.warnings !== undefined) {
      warnings.push(...page.warnings);
    }
    index += 1;
    onProgress?.(
      sourceHeartbeat({
        currentItem: { title: `page ${String(index)}` },
        done: pages.length,
        metrics: { pages: pages.length },
        phase: "pages",
        source: "notion",
      }),
    );
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor.length > 0);
  return { pages, warnings };
}

/** Page the `databases` lane to exhaustion, collecting summaries + row pages + per-page heartbeats. */
async function pageAllDatabases({
  api,
  since,
  onProgress,
}: {
  api: NotionApi;
  since: string;
  onProgress?: SourceProgress;
}): Promise<{
  databases: readonly NotionDatabaseItem[];
  rows: readonly NotionPageItem[];
  warnings: readonly string[];
}> {
  const databases: NotionDatabaseItem[] = [];
  const rows: NotionPageItem[] = [];
  const warnings: string[] = [];
  let cursor: string | undefined;
  let index = 0;
  do {
    const page = await api.databases({ since, ...(cursor !== undefined ? { cursor } : {}) });
    if (index === 0 && page.databases[0] !== undefined) {
      onProgress?.(notionDatabasePreview({ database: page.databases[0] }));
    }
    databases.push(...page.databases);
    rows.push(...page.rows);
    if (page.warnings !== undefined) {
      warnings.push(...page.warnings);
    }
    index += 1;
    onProgress?.(
      sourceHeartbeat({
        done: databases.length,
        metrics: { databases: databases.length, rows: rows.length },
        phase: "databases",
        source: "notion",
      }),
    );
    cursor = page.nextCursor;
  } while (cursor !== undefined && cursor.length > 0);
  return { databases, rows, warnings };
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

/** The rendered rich-text line of one raw block (empty when the block has no rich-text body). Pure. */
export function blockTextLine({ block }: { block: Record<string, unknown> }): string {
  const type = typeof block["type"] === "string" ? block["type"] : undefined;
  const body = type !== undefined ? block[type] : undefined;
  return isRecord(body) ? renderRichText({ richText: body["rich_text"] }) : "";
}

/** The explicit mention target node keys in one raw block's rich text (page/database/user spans). Pure. */
export function blockMentions({ block }: { block: Record<string, unknown> }): readonly string[] {
  const type = typeof block["type"] === "string" ? block["type"] : undefined;
  const body = type !== undefined ? block[type] : undefined;
  return isRecord(body) ? extractMentions({ richText: body["rich_text"] }) : [];
}

/** The child block id to recurse into (`has_children` + a string id), or undefined. Pure. */
export function blockChildId({ block }: { block: Record<string, unknown> }): string | undefined {
  return block["has_children"] === true && typeof block["id"] === "string" ? block["id"] : undefined;
}

/** One `blocks.children.list` page — the sole `client.blocks` boundary, gated + safe-wrapped. */
async function listBlockChildren({
  client,
  call,
  blockId,
  cursor,
}: {
  client: Client;
  call: GatedCall;
  blockId: string;
  cursor: string | undefined;
}): Promise<{ results: readonly unknown[]; nextCursor: string | undefined }> {
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
  return { nextCursor: notionNextCursor({ value: res.next_cursor }), results: res.results };
}

/** A page's rendered body: plain text + the explicit mention targets + ref-only file lines it contains. */
interface RenderedBlocks {
  readonly text: string;
  readonly mentions: readonly string[];
  readonly fileRefs: readonly string[];
}

/** One block's own (non-recursive) contribution: its rendered line, mention targets, and file ref. Pure. */
function blockContribution({ block }: { block: Record<string, unknown> }): {
  line: string;
  mentions: readonly string[];
  fileRefs: readonly string[];
} {
  const fileRef = blockFileRef({ block });
  return {
    fileRefs: fileRef !== undefined ? [fileRef] : [],
    line: blockTextLine({ block }),
    mentions: blockMentions({ block }),
  };
}

/**
 * Recursively render a page's block children to plain text — and collect the explicit mention targets +
 * ref-only file/media lines along the way — bounded by depth. Every call is rate-gated.
 */
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
}): Promise<RenderedBlocks> {
  if (depth > MAX_BLOCK_DEPTH) {
    return { fileRefs: [], mentions: [], text: "" };
  }
  const lines: string[] = [];
  const mentions: string[] = [];
  const fileRefs: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await listBlockChildren({ blockId, call, client, cursor });
    for (const result of page.results) {
      if (!isRecord(result)) {
        continue;
      }
      const contrib = blockContribution({ block: result });
      lines.push(contrib.line);
      mentions.push(...contrib.mentions);
      fileRefs.push(...contrib.fileRefs);
      const childId = blockChildId({ block: result });
      if (childId !== undefined) {
        const child = await renderBlocks({ blockId: childId, call, client, depth: depth + 1 });
        lines.push(child.text);
        mentions.push(...child.mentions);
        fileRefs.push(...child.fileRefs);
      }
    }
    cursor = page.nextCursor;
  } while (cursor !== undefined);
  return { fileRefs, mentions, text: lines.filter((line) => line.length > 0).join("\n\n") };
}

/** The `since` cutoff in epoch-ms, or undefined when `since` means "no cutoff" (the `--all` epoch date). */
export function cutoffMs({ since }: { since: string }): number | undefined {
  if (since <= "1970-01-01") {
    return undefined;
  }
  return parseYyyyMmDdUtcMs({ date: since });
}

/** Whether a result's `last_edited_time` is at/after the cutoff (undated or no-cutoff ⇒ keep). */
export function withinCutoff({ lastEdited, cutoff }: { lastEdited: string; cutoff: number | undefined }): boolean {
  if (cutoff === undefined) {
    return true;
  }
  const ms = parseIsoMs({ tsIso: lastEdited });
  return ms === undefined ? true : ms >= cutoff;
}

/** The Notion `next_cursor` off a raw search/list response — non-empty string ⇒ another page, else stop. */
export function notionNextCursor({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
      cursor = notionNextCursor({ value: res.next_cursor });
    } while (cursor !== undefined);
  } catch (error: unknown) {
    return {
      comments,
      warnings: [`comments for page ${pageId} failed: ${error instanceof Error ? error.message : "unknown"}`],
    };
  }
  return { comments, warnings: [] };
}

/** Collect the in-window rows on one `dataSources.query` result page (each with its comments), rate-gated. */
async function rowsFromQueryPage({
  client,
  call,
  dataSourceId,
  cutoff,
  results,
}: {
  client: Client;
  call: GatedCall;
  dataSourceId: string;
  cutoff: number | undefined;
  results: readonly unknown[];
}): Promise<{ rows: readonly NotionPageItem[]; warnings: readonly string[] }> {
  const rows: NotionPageItem[] = [];
  const warnings: string[] = [];
  for (const result of results) {
    const raw: unknown = result;
    if (
      !isRecord(raw) ||
      typeof raw["id"] !== "string" ||
      !withinCutoff({ cutoff, lastEdited: lastEditedOf({ raw }) })
    ) {
      continue; // id-less, or out of window (rows aren't ordered — filter, don't stop paging)
    }
    const comments = await pageComments({ call, client, pageId: raw["id"] });
    warnings.push(...comments.warnings);
    rows.push(
      projectRowItem({
        comments: comments.comments,
        dataSourceId,
        id: raw["id"],
        lastEdited: lastEditedOf({ raw }),
        raw,
      }),
    );
  }
  return { rows, warnings };
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
}): Promise<{ rows: readonly NotionPageItem[]; warnings: readonly string[] }> {
  const rows: NotionPageItem[] = [];
  const warnings: string[] = [];
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
    const page = await rowsFromQueryPage({ call, client, cutoff, dataSourceId, results: res.results });
    rows.push(...page.rows);
    warnings.push(...page.warnings);
    const next = notionNextCursor({ value: res.next_cursor });
    if (next === undefined) {
      return { rows, warnings };
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

/** Project a raw Notion page into a page item (its rendered text chunked, comments + curated refs attached). Pure. */
export function projectPageItem({
  raw,
  id,
  lastEdited,
  text,
  comments,
  mentionTargets = [],
  fileRefs = [],
}: {
  raw: Record<string, unknown>;
  id: string;
  lastEdited: string;
  text: string;
  comments: readonly NotionCommentItem[];
  mentionTargets?: readonly string[];
  fileRefs?: readonly string[];
}): NotionPageItem {
  const relationTargets = extractRelationTargets({ properties: raw["properties"] });
  return {
    chunks: chunkText({ text }),
    comments,
    id,
    raw,
    title: titleFrom({ raw }),
    tsIso: lastEdited,
    url: typeof raw["url"] === "string" ? raw["url"] : "",
    ...(relationTargets.length > 0 ? { relationTargets } : {}),
    ...(mentionTargets.length > 0 ? { mentionTargets } : {}),
    ...(fileRefs.length > 0 ? { fileRefs } : {}),
  };
}

/** Project a raw data-source ROW into a page item (properties flattened + chunked, relations/files/comments). Pure. */
export function projectRowItem({
  raw,
  id,
  dataSourceId,
  lastEdited,
  comments = [],
}: {
  raw: Record<string, unknown>;
  id: string;
  dataSourceId: string;
  lastEdited: string;
  comments?: readonly NotionCommentItem[];
}): NotionPageItem {
  const { title, text } = renderRowProperties({ properties: raw["properties"] });
  const relationTargets = extractRelationTargets({ properties: raw["properties"] });
  const fileRefs = extractFilePropertyRefs({ properties: raw["properties"] });
  return {
    chunks: chunkText({ text }),
    comments,
    id,
    parent: dataSourceId,
    raw,
    title: title.length > 0 ? title : "(row)",
    tsIso: lastEdited,
    url: typeof raw["url"] === "string" ? raw["url"] : "",
    ...(relationTargets.length > 0 ? { relationTargets } : {}),
    ...(fileRefs.length > 0 ? { fileRefs } : {}),
  };
}

/** A non-empty string field off a raw object, else undefined. */
function notionStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Project one raw Notion `users.list` object into a {@link MemberBronzeRow}. Email is captured ONLY for a
 * `type === "person"` (bots have none) AND only when the integration's user-email capability granted it
 * (else a warning + `missing` trust — never a guessed email). The full raw user is kept. Pure.
 *
 * @param raw the raw user object
 * @param fetchedAtIso the hydration timestamp
 * @returns the member row, or `undefined` when id-less
 */
export function projectNotionUser({
  raw,
  fetchedAtIso,
}: {
  raw: unknown;
  fetchedAtIso: string;
}): MemberBronzeRow | undefined {
  const id = isRecord(raw) ? notionStr({ value: raw["id"] }) : undefined;
  if (!isRecord(raw) || id === undefined) {
    return undefined;
  }
  const isBot = raw["type"] === "bot";
  const person = isRecord(raw["person"]) ? raw["person"] : {};
  const email = isBot ? undefined : notionStr({ value: person["email"] });
  const name = notionStr({ value: raw["name"] });
  const avatarUrl = notionStr({ value: raw["avatar_url"] });
  return {
    fetchedAtIso,
    identity: buildMemberIdentity({
      nativeId: id,
      source: "notion",
      ...(name !== undefined ? { name } : {}),
      ...(email !== undefined ? { email } : {}),
    }),
    profile: { bot: isBot, ...(avatarUrl !== undefined ? { avatarUrl } : {}) },
    provenance: ["notion.users.list"],
    raw,
    source: "notion",
    sourceId: id,
    version: 1,
    warnings:
      !isBot && email === undefined ? ["no email — the Notion integration lacks the read-user-email capability"] : [],
  };
}

/**
 * Hydrate every Notion workspace member (`users.list`, paged), projecting each + finalising trust. A
 * failure is fatal (`err`).
 *
 * @param api the injected Notion seam
 * @param fetchedAtIso the hydration timestamp
 * @returns the member rows + warnings, or `err` on a fatal failure
 */
export async function fetchNotionMembers({
  api,
  fetchedAtIso,
}: {
  api: NotionApi;
  fetchedAtIso: string;
}): Promise<Result<{ rows: readonly MemberBronzeRow[]; warnings: readonly string[] }>> {
  const rows: MemberBronzeRow[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await api.users(cursor !== undefined ? { cursor } : {});
      for (const raw of page.results) {
        const row = projectNotionUser({ fetchedAtIso, raw });
        if (row !== undefined) {
          rows.push(row);
        }
      }
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    return err([`notion member hydration failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  const finalised = finaliseMemberTrust({ rows });
  return ok({ rows: finalised, warnings: aggregateMemberWarnings({ rows: finalised }) });
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

// Notion `search` has no server-side date filter, so we sort by `last_edited_time` DESCENDING and stop
// paging once a result older than `since` appears (all subsequent are older). `--all` ⇒ no cutoff.
const SORT_NEWEST_FIRST = { direction: "descending", timestamp: "last_edited_time" } as const;

/** The page's next cursor, suppressed once the `since` cutoff was reached mid-page (stop paging). Pure. */
function searchNextCursor({
  nextCursor,
  reachedCutoff,
}: {
  nextCursor: unknown;
  reachedCutoff: boolean;
}): string | undefined {
  return reachedCutoff ? undefined : notionNextCursor({ value: nextCursor });
}

/** One `search` call for a given object type — the sole `client.search` boundary, gated + safe-wrapped. */
async function notionSearch({
  client,
  call,
  objectType,
  operation,
  cursor,
}: {
  client: Client;
  call: GatedCall;
  objectType: "page" | "data_source";
  operation: string;
  cursor: string | undefined;
}): Promise<{ results: readonly unknown[]; nextCursor: unknown }> {
  const res = orThrow({
    result: await safeApiCall({
      execute: () =>
        call(() =>
          client.search({
            filter: { property: "object", value: objectType },
            page_size: PAGE_SIZE,
            sort: SORT_NEWEST_FIRST,
            ...(cursor !== undefined ? { start_cursor: cursor } : {}),
          }),
        ),
      operation,
      provider: "notion",
    }),
  });
  return { nextCursor: res.next_cursor, results: res.results };
}

/** The live `databases` seam method: each `data_source` hit + its queried rows, cutoff-honoured. */
function notionDatabasesMethod({ client, call }: { client: Client; call: GatedCall }): NotionApi["databases"] {
  return async ({ since, cursor }) => {
    const cutoff = cutoffMs({ since });
    const { results, nextCursor } = await notionSearch({
      call,
      client,
      cursor,
      objectType: "data_source",
      operation: "notion.search.databases",
    });
    const databases: NotionDatabaseItem[] = [];
    const rows: NotionPageItem[] = [];
    const warnings: string[] = [];
    let reachedCutoff = false;
    for (const result of results) {
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
      const queried = await dataSourceRows({ call, client, cutoff, dataSourceId: raw["id"] });
      rows.push(...queried.rows);
      warnings.push(...queried.warnings);
    }
    const next = searchNextCursor({ nextCursor, reachedCutoff });
    return {
      databases,
      rows,
      ...(next !== undefined ? { nextCursor: next } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };
}

/** The live `pages` seam method: each page's recursively-rendered text + comments, cutoff-honoured. */
function notionPagesMethod({ client, call }: { client: Client; call: GatedCall }): NotionApi["pages"] {
  return async ({ since, cursor }) => {
    const cutoff = cutoffMs({ since });
    const { results, nextCursor } = await notionSearch({
      call,
      client,
      cursor,
      objectType: "page",
      operation: "notion.search.pages",
    });
    const pages: NotionPageItem[] = [];
    const warnings: string[] = [];
    let reachedCutoff = false;
    for (const result of results) {
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
      const rendered = await renderBlocks({ blockId: id, call, client, depth: 0 });
      const comments = await pageComments({ call, client, pageId: id });
      warnings.push(...comments.warnings);
      pages.push(
        projectPageItem({
          comments: comments.comments,
          fileRefs: rendered.fileRefs,
          id,
          lastEdited,
          mentionTargets: rendered.mentions,
          raw,
          text: rendered.text,
        }),
      );
    }
    const next = searchNextCursor({ nextCursor, reachedCutoff });
    return {
      pages,
      ...(next !== undefined ? { nextCursor: next } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  };
}

/** The live `users.list` seam method: one page of raw workspace members — the sole `client.users` boundary. */
function notionUsersMethod({ client, call }: { client: Client; call: GatedCall }): NotionApi["users"] {
  return async ({ cursor }) => {
    const res = orThrow({
      result: await safeApiCall({
        execute: () =>
          call(() =>
            client.users.list({
              page_size: PAGE_SIZE,
              ...(cursor !== undefined ? { start_cursor: cursor } : {}),
            }),
          ),
        operation: "notion.users.list",
        provider: "notion",
      }),
    });
    const next = notionNextCursor({ value: res.next_cursor });
    return { results: res.results, ...(next !== undefined ? { nextCursor: next } : {}) };
  };
}

/**
 * Build the production Notion seam over a live `Client`. Search discovery, recursive block rendering,
 * chunking, comment fetches, data-source row queries, AND member hydration — every call gated through ONE
 * shared rate scheduler (~3 req/s) + transient retry so a big recursive crawl never self-429s.
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
  return {
    databases: notionDatabasesMethod({ call, client }),
    pages: notionPagesMethod({ call, client }),
    users: notionUsersMethod({ call, client }),
  };
}
