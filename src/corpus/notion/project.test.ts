import { describe, expect, it } from "vitest";
import { type NotionDatabaseItem, type NotionPageItem, projectNotionRecords } from "./project.js";

const page: NotionPageItem = {
  chunks: ["## Rollout plan\nStage the migration.", "## Risks\nBackfill volume."],
  comments: [{ author: "Sam", body: "looks good", id: "cmt1", tsIso: "2026-05-02T00:00:00.000Z" }],
  id: "pg1",
  title: "Migration doc",
  tsIso: "2026-05-01T00:00:00.000Z",
  url: "https://notion.so/pg1",
};

const database: NotionDatabaseItem = {
  description: "all tracked services",
  id: "db1",
  title: "Service registry",
  tsIso: "2026-05-01T00:00:00.000Z",
  url: "https://notion.so/db1",
};

describe("projectNotionRecords", () => {
  it("projects each page chunk to a `page` record with a stable chunk id + section title", () => {
    const records = projectNotionRecords({ databases: [], pages: [page] });
    const chunks = records.filter((r) => r.kind === "page");
    expect(chunks.map((r) => r.sourceId)).toEqual(["page:pg1:chunk:0", "page:pg1:chunk:1"]);
    expect(chunks[0]!.title).toBe("Migration doc (1/2)");
    expect(chunks[0]!.text).toContain("Rollout plan");
    expect(chunks[0]!.url).toBe("https://notion.so/pg1");
  });

  it("uses a single un-suffixed id when a page is one chunk", () => {
    const records = projectNotionRecords({ databases: [], pages: [{ ...page, chunks: ["one section only"] }] });
    const chunk = records.find((r) => r.kind === "page")!;
    expect(chunk.sourceId).toBe("page:pg1");
    expect(chunk.title).toBe("Migration doc");
  });

  it("projects page comments to comment records keyed by page + comment id", () => {
    const records = projectNotionRecords({ databases: [], pages: [page] });
    const comment = records.find((r) => r.kind === "comment")!;
    expect(comment.sourceId).toBe("page:pg1:comment:cmt1");
    expect(comment.text).toBe("looks good");
  });

  it("projects a database to a `database` record keyed by database id", () => {
    const records = projectNotionRecords({ databases: [database], pages: [] });
    expect(records).toHaveLength(1);
    expect(records[0]!.kind).toBe("database");
    expect(records[0]!.sourceId).toBe("database:db1");
    expect(records[0]!.text).toBe("all tracked services");
  });
});
