import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import {
  dataSourceSchema,
  fetchNotionStructures,
  type NotionStructuresApi,
  projectDataSourceRow,
} from "./structures.js";

const AT = "2026-07-20T00:00:00.000Z";

const DATA_SOURCE = {
  description: [{ plain_text: "the roadmap tracker" }],
  id: "ds1",
  parent: { database_id: "db1", type: "database_id" },
  properties: {
    Name: { id: "title", name: "Name", type: "title" },
    Status: {
      id: "abc%40",
      name: "Status",
      status: {
        options: [
          { id: "o1", name: "Todo" },
          { id: "o2", name: "Done" },
        ],
      },
      type: "status",
    },
  },
  title: [{ plain_text: "Roadmap" }],
  url: "https://notion.so/ds1",
};

describe("dataSourceSchema", () => {
  it("captures each property's id/name/type/options (the field the activity lane dropped)", () => {
    expect(dataSourceSchema({ raw: DATA_SOURCE })).toEqual([
      { id: "title", name: "Name", options: [], type: "title" },
      { id: "abc%40", name: "Status", options: ["Todo", "Done"], type: "status" },
    ]);
  });
});

describe("projectDataSourceRow", () => {
  it("captures a REAL description (not the old empty string) + property summary + parent relation", () => {
    const row = projectDataSourceRow({ fetchedAtIso: AT, raw: DATA_SOURCE })!;
    expect(row.attrs["description"]).toBe("the roadmap tracker");
    expect(row.attrs["propertyCount"]).toBe(2);
    expect(row.attrs["propertyNames"]).toEqual(["Name", "Status"]);
    expect(row.relations).toEqual([
      {
        attrs: { parentType: "database_id" },
        targetId: "db1",
        targetKind: "container",
        targetSource: "notion",
        type: "parent",
      },
    ]);
  });

  it("flags teamspace as inferred (not authoritative) when a parent is present", () => {
    const row = projectDataSourceRow({ fetchedAtIso: AT, raw: DATA_SOURCE })!;
    expect(row.warnings).toEqual(["teamspace is inferred from the parent pointer, not authoritative"]);
  });
});

/** A fake Notion structure seam. */
function fakeApi(): NotionStructuresApi {
  return {
    listDataSources: async () => ({ results: [{ id: "ds1" }] }),
    retrieveDataSource: async () => DATA_SOURCE,
  };
}

describe("fetchNotionStructures", () => {
  it("discovers + retrieves each data source into a schema row", async () => {
    const result = unwrap(await fetchNotionStructures({ api: fakeApi(), fetchedAtIso: AT }));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.kind).toBe("data_source");
    expect(result.rows[0]!.attrs["propertyCount"]).toBe(2);
  });
});
