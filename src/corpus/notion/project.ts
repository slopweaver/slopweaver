/**
 * Pure projection: shaped Notion items → `CorpusRecord[]`. No I/O — block recursion + rich-text
 * rendering already happened in `fetch.ts`. A page fans out into one **page** record per section chunk
 * (`page:<id>` for a single chunk, `page:<id>:chunk:<i>` for many) so a long doc isn't buried in one
 * giant atom; databases become **database** records (`database:<id>`); comments become **comment**
 * records. File/image mentions are kept as reference text only, never bytes or expiring signed URLs.
 */

import { extractRefs } from "../refs.js";
import type { CorpusRecord } from "../types.js";

/** A Notion comment, already shaped by the fetch edge. */
export interface NotionCommentItem {
  readonly id: string;
  readonly body: string;
  readonly author?: string;
  readonly tsIso: string;
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
}

/** A Notion database's metadata. */
export interface NotionDatabaseItem {
  readonly id: string;
  readonly title: string;
  readonly url: string;
  readonly tsIso: string;
  readonly description: string;
}

/** Page-chunk records + comment records for one page. */
function pageRecords({ page }: { page: NotionPageItem }): CorpusRecord[] {
  const container = page.parent !== undefined && page.parent.length > 0 ? `notion/${page.parent}` : "notion";
  const chunks = page.chunks.length > 0 ? page.chunks : [page.title];
  const single = chunks.length === 1;
  const records: CorpusRecord[] = chunks.map(
    (chunk, index): CorpusRecord => ({
      container,
      kind: "page",
      refs: extractRefs({ text: chunk }),
      source: "notion",
      sourceId: single ? `page:${page.id}` : `page:${page.id}:chunk:${String(index)}`,
      text: chunk.length > 0 ? chunk : page.title,
      title: single ? page.title : `${page.title} (${String(index + 1)}/${String(chunks.length)})`,
      tsIso: page.tsIso,
      url: page.url,
    }),
  );
  for (const comment of page.comments) {
    if (comment.body.trim().length === 0) {
      continue;
    }
    records.push({
      container,
      kind: "comment",
      refs: extractRefs({ text: comment.body }),
      source: "notion",
      sourceId: `page:${page.id}:comment:${comment.id}`,
      text: comment.body,
      tsIso: comment.tsIso,
      url: page.url,
      ...(comment.author !== undefined ? { author: comment.author } : {}),
    });
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
