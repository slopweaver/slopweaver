/**
 * The Notion STRUCTURE lane: capture each data-source's SCHEMA (every property's id/name/type/options — the
 * thing the activity lane threw away, hard-coding `description: ""`) plus its parent pointer, into
 * {@link StructureBronzeRow}s. Teamspace ownership is deliberately treated as INFERRED-only: the public API
 * exposes a parent id/type but not a first-class teamspace graph, so we store the parent pointer + a warning
 * rather than inventing team ownership (D8 — honest "inferred", never false certainty). Every SDK call is a
 * `safe*`-wrapped, injected seam so it's unit-tested with a fake.
 */
import { Client } from "@notionhq/client";
import { isRecord } from "../../lib/parsers.js";
import { createRateScheduler, retryTransient } from "../../lib/resilience.js";
import { err, ok, type Result } from "../../lib/result.js";
import { orThrow, safeApiCall } from "../../lib/safeBoundary.js";
import type { StructureBronzeRow, StructureRelation } from "../structures/types.js";
import { notionNextCursor, renderRichText } from "./fetch.js";

const PAGE_SIZE = 100;
const NOTION_RATE_PER_SEC = 3;

/** The injected Notion structure seam. `listDataSources` discovers; `retrieveDataSource` gives full schema. */
export interface NotionStructuresApi {
  listDataSources: (args: { cursor?: string }) => Promise<{ results: readonly unknown[]; nextCursor?: string }>;
  retrieveDataSource: (args: { id: string }) => Promise<unknown>;
}

/** One captured schema property — the id/name/type/options the old activity projection dropped. */
export interface SchemaProperty {
  readonly id: string;
  readonly name: string;
  readonly type: string;
  readonly options: readonly string[];
}

/** A non-empty string off a raw object, else undefined. Pure. */
function nStr({ value }: { value: unknown }): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The option NAMES off a property's type-specific config (`select`/`status`/`multi_select`). Pure. */
function propertyOptions({ config }: { config: unknown }): readonly string[] {
  if (!isRecord(config) || !Array.isArray(config["options"])) {
    return [];
  }
  return config["options"]
    .map((option) => (isRecord(option) ? nStr({ value: option["name"] }) : undefined))
    .filter((name): name is string => name !== undefined);
}

/**
 * Extract a data-source's property schema (id/name/type/options per property) from its raw `properties` map.
 * Deterministic (property-name order). Pure — this is the capture the old `description: ""` projection lost.
 *
 * @param raw the raw data-source object
 * @returns the schema properties, sorted by name
 */
export function dataSourceSchema({ raw }: { raw: unknown }): readonly SchemaProperty[] {
  const properties = isRecord(raw) ? raw["properties"] : undefined;
  if (!isRecord(properties)) {
    return [];
  }
  const schema: SchemaProperty[] = [];
  for (const [propName, value] of Object.entries(properties)) {
    if (!isRecord(value)) {
      continue;
    }
    const type = nStr({ value: value["type"] });
    const id = nStr({ value: value["id"] });
    if (type === undefined || id === undefined) {
      continue;
    }
    schema.push({
      id,
      name: nStr({ value: value["name"] }) ?? propName,
      options: propertyOptions({ config: value[type] }),
      type,
    });
  }
  return schema.toSorted((a, b) => a.name.localeCompare(b.name));
}

/** The rendered title off a data-source's `title` rich-text array, else undefined. Pure. */
function titleOf({ raw }: { raw: Record<string, unknown> }): string | undefined {
  const rendered = renderRichText({ richText: raw["title"] });
  return rendered.length > 0 ? rendered : undefined;
}

/** The `parent` relation off a data-source's parent pointer (INFERRED teamspace/container). Pure. */
function parentRelation({ raw }: { raw: Record<string, unknown> }): readonly StructureRelation[] {
  const parent = raw["parent"];
  if (!isRecord(parent)) {
    return [];
  }
  const parentType = nStr({ value: parent["type"] });
  const parentId = parentType !== undefined ? nStr({ value: parent[parentType] }) : undefined;
  if (parentId === undefined) {
    return [];
  }
  return [
    {
      targetId: parentId,
      targetKind: "container",
      targetSource: "notion",
      type: "parent",
      ...(parentType !== undefined ? { attrs: { parentType } } : {}),
    },
  ];
}

/**
 * Project one raw Notion data-source object into a `data_source` structure row: its schema summarised into
 * `attrs` (property names + count + description) with the full id/type/options preserved in `raw` (read back
 * via {@link dataSourceSchema}), plus the inferred parent relation. Pure — undefined without an id.
 *
 * @param raw the raw data-source object
 * @param fetchedAtIso the hydration timestamp
 * @returns the data-source row, or `undefined`
 */
export function projectDataSourceRow({
  raw,
  fetchedAtIso,
}: {
  raw: unknown;
  fetchedAtIso: string;
}): StructureBronzeRow | undefined {
  const id = isRecord(raw) ? nStr({ value: raw["id"] }) : undefined;
  if (!isRecord(raw) || id === undefined) {
    return undefined;
  }
  const schema = dataSourceSchema({ raw });
  const description = renderRichText({ richText: raw["description"] });
  const url = nStr({ value: raw["url"] });
  const title = titleOf({ raw });
  return {
    attrs: {
      propertyCount: schema.length,
      propertyNames: schema.map((property) => property.name),
      ...(description.length > 0 ? { description } : {}),
    },
    fetchedAtIso,
    identity: { nativeId: id, ...(title !== undefined ? { name: title } : {}), ...(url !== undefined ? { url } : {}) },
    kind: "data_source",
    provenance: ["notion.dataSources.retrieve"],
    raw,
    relations: parentRelation({ raw }),
    source: "notion",
    sourceId: id,
    version: 1,
    // Teamspace ownership is not first-class in the public API — the parent pointer is a hint, not truth.
    warnings:
      parentRelation({ raw }).length > 0 ? ["teamspace is inferred from the parent pointer, not authoritative"] : [],
  };
}

/**
 * Hydrate Notion data-source schemas: discover every accessible data source, retrieve its full object, and
 * project the schema row. A discovery failure is fatal (`err`); a per-source retrieve failure warns + skips.
 *
 * @param api the injected Notion structure seam
 * @param fetchedAtIso the hydration timestamp
 * @returns the structure rows + warnings, or `err` on a fatal discovery failure
 */
export async function fetchNotionStructures({
  api,
  fetchedAtIso,
}: {
  api: NotionStructuresApi;
  fetchedAtIso: string;
}): Promise<Result<{ rows: readonly StructureBronzeRow[]; warnings: readonly string[] }>> {
  const ids = await discoverDataSourceIds({ api });
  if (ids.ok === false) {
    return ids;
  }
  return ok(await retrieveAll({ api, fetchedAtIso, ids: ids.value }));
}

/** The data-source ids off one `search` results page (id-less hits dropped). Pure. */
function dataSourceIdsFromPage({ results }: { results: readonly unknown[] }): readonly string[] {
  return results
    .map((raw) => (isRecord(raw) ? nStr({ value: raw["id"] }) : undefined))
    .filter((id): id is string => id !== undefined);
}

/** Page every accessible data-source id from the seam (a discovery failure is fatal `err`). */
async function discoverDataSourceIds({ api }: { api: NotionStructuresApi }): Promise<Result<readonly string[]>> {
  const ids: string[] = [];
  try {
    let cursor: string | undefined;
    do {
      const page = await api.listDataSources(cursor !== undefined ? { cursor } : {});
      ids.push(...dataSourceIdsFromPage({ results: page.results }));
      cursor = page.nextCursor;
    } while (cursor !== undefined && cursor.length > 0);
  } catch (error: unknown) {
    return err([`notion structure discovery failed: ${error instanceof Error ? error.message : "unknown"}`]);
  }
  return ok(ids);
}

/** Retrieve + project each discovered data source (a per-source failure warns + skips). */
async function retrieveAll({
  api,
  ids,
  fetchedAtIso,
}: {
  api: NotionStructuresApi;
  ids: readonly string[];
  fetchedAtIso: string;
}): Promise<{ rows: readonly StructureBronzeRow[]; warnings: readonly string[] }> {
  const rows: StructureBronzeRow[] = [];
  const warnings: string[] = [];
  for (const id of ids) {
    try {
      const raw = await api.retrieveDataSource({ id });
      const row = projectDataSourceRow({ fetchedAtIso, raw });
      if (row !== undefined) {
        rows.push(row);
      }
    } catch (error: unknown) {
      warnings.push(`notion data source ${id}: ${error instanceof Error ? error.message : "unknown"}`);
    }
  }
  return { rows, warnings };
}

/**
 * Build the production Notion structure seam over a live `Client`, rate-gated + transient-retried like the
 * activity lane. Discovery reuses `search` (object=data_source); each schema comes from `dataSources.retrieve`.
 *
 * @param token the Notion integration token
 * @returns the live Notion structure seam
 */
export function makeNotionStructuresApi({ token }: { token: string }): NotionStructuresApi {
  const client = new Client({ auth: token });
  const gate = createRateScheduler({ ratePerSec: NOTION_RATE_PER_SEC });
  const call = <T>(task: () => Promise<T>): Promise<T> => retryTransient({ operation: () => gate(task) });
  return {
    listDataSources: async ({ cursor }) => {
      const res = orThrow({
        result: await safeApiCall({
          execute: () =>
            call(() =>
              client.search({
                filter: { property: "object", value: "data_source" },
                page_size: PAGE_SIZE,
                ...(cursor !== undefined ? { start_cursor: cursor } : {}),
              }),
            ),
          operation: "notion.search.dataSources",
          provider: "notion",
        }),
      });
      const next = notionNextCursor({ value: res.next_cursor });
      return { results: res.results, ...(next !== undefined ? { nextCursor: next } : {}) };
    },
    retrieveDataSource: async ({ id }) =>
      orThrow({
        result: await safeApiCall({
          execute: () => call(() => client.dataSources.retrieve({ data_source_id: id })),
          operation: "notion.dataSources.retrieve",
          provider: "notion",
        }),
      }),
  };
}
