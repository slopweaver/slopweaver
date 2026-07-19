/**
 * Pure projection: shaped Notion items → `CorpusRecord[]`. No I/O — block recursion + rich-text
 * rendering already happened in `fetch.ts`. A page fans out into one **page** record per section chunk
 * (`page:<id>` for a single chunk, `page:<id>:chunk:<i>` for many) so a long doc isn't buried in one
 * giant atom; databases become **database** records (`database:<id>`); comments become **comment**
 * records. File/image mentions are kept as reference text only, never bytes or expiring signed URLs.
 */

import { extractRefs } from "../refs.js";
import type { CorpusAttributeValue, CorpusRecord } from "../types.js";

/** A Notion comment, already shaped by the fetch edge. */
export interface NotionCommentItem {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly tsIso: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A Notion page with its rich text rendered + chunked into sections. */
export interface NotionPageItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly tsIso: string;
  readonly parent?: string;
  readonly chunks: readonly string[];
  readonly comments: readonly NotionCommentItem[];
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** A Notion database's metadata. */
export interface NotionDatabaseItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly tsIso: string;
  readonly description: string;
  readonly raw?: Readonly<Record<string, unknown>>;
}

/** The `attrs` for one page chunk: `parent` when the page has one, chunk position when multi-chunk. Pure. */
function pageChunkAttrs({
  page,
  index,
  chunkCount,
}: {
  page: NotionPageItem;
  index: number;
  chunkCount: number;
}): Record<string, CorpusAttributeValue> {
  const attrs: Record<string, CorpusAttributeValue> = {};
  if (page.parent !== undefined && page.parent.length > 0) {
    attrs["parent"] = page.parent;
  }
  if (chunkCount > 1) {
    attrs["chunkIndex"] = index;
    attrs["chunkCount"] = chunkCount;
  }
  return attrs;
}

/** One page-chunk record (single-chunk pages keep the bare `page:<id>` id + title). Pure. */
function pageChunkRecord({
  page,
  container,
  chunk,
  index,
  chunkCount,
}: {
  page: NotionPageItem;
  container: string;
  chunk: string;
  index: number;
  chunkCount: number;
}): CorpusRecord {
  const single = chunkCount === 1;
  const attrs = pageChunkAttrs({ chunkCount, index, page });
  return {
    container,
    kind: "page",
    refs: extractRefs({ text: chunk }),
    source: "notion",
    sourceId: single ? `page:${page.id}` : `page:${page.id}:chunk:${String(index)}`,
    text: chunk.length > 0 ? chunk : page.title,
    title: single ? page.title : `${page.title} (${String(index + 1)}/${String(chunkCount)})`,
    tsIso: page.tsIso,
    url: page.url,
    ...(Object.keys(attrs).length > 0 ? { attrs } : {}),
    ...(page.raw !== undefined ? { raw: page.raw } : {}),
  };
}

/** One page-comment record. Pure. */
function pageCommentRecord({
  page,
  container,
  comment,
}: {
  page: NotionPageItem;
  container: string;
  comment: NotionCommentItem;
}): CorpusRecord {
  return {
    container,
    kind: "comment",
    refs: extractRefs({ text: comment.body }),
    source: "notion",
    sourceId: `page:${page.id}:comment:${comment.id}`,
    text: comment.body,
    tsIso: comment.tsIso,
    url: page.url,
    ...(comment.author !== undefined ? { author: comment.author } : {}),
    ...(comment.raw !== undefined ? { raw: comment.raw } : {}),
  };
}

/** Page-chunk records + comment records for one page. Composes the pure chunk/comment builders. */
function pageRecords({ page }: { page: NotionPageItem }): CorpusRecord[] {
  const container = page.parent !== undefined && page.parent.length > 0 ? `notion/${page.parent}` : "notion";
  const chunks = page.chunks.length > 0 ? page.chunks : [page.title];
  const records: CorpusRecord[] = chunks.map((chunk, index) =>
    pageChunkRecord({ chunk, chunkCount: chunks.length, container, index, page }),
  );
  for (const comment of page.comments) {
    if (comment.body.trim().length === 0) {
      continue;
    }
    records.push(pageCommentRecord({ comment, container, page }));
  }
  return records;
}

/** One database metadata record. */
function databaseRecord({ database }: { database: NotionDatabaseItem }): CorpusRecord {
  return {
    container: "notion",
    kind: "database",
    refs: extractRefs({ text: `${database.title}\n${database.description}` }),
    source: "notion",
    sourceId: `database:${database.id}`,
    text: database.description.length > 0 ? database.description : database.title,
    title: database.title,
    tsIso: database.tsIso,
    url: database.url,
    ...(database.raw !== undefined ? { raw: database.raw } : {}),
  };
}

/**
 * Project pages (chunked) + their comments and databases into corpus records.
 *
 * @param pages the fetched pages
 * @param databases the fetched databases
 * @returns the flattened corpus records
 */
export function projectNotionRecords({
  pages,
  databases,
}: {
  pages: readonly NotionPageItem[];
  databases: readonly NotionDatabaseItem[];
}): readonly CorpusRecord[] {
  const records: CorpusRecord[] = [];
  for (const page of pages) {
    records.push(...pageRecords({ page }));
  }
  for (const database of databases) {
    records.push(databaseRecord({ database }));
  }
  return records;
}
