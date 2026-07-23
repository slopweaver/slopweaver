import { describe, expect, it } from "vitest";
import { type NotionDatabaseItem, type NotionPageItem, projectNotionRecords } from "./project.js";

const rawPage = { id: "pg1", rawMarker: "notion-page" };
const rawComment = { id: "cmt1", rawMarker: "notion-comment" };
const rawDatabase = { id: "db1", rawMarker: "notion-database" };

const page: NotionPageItem = {
  chunks: ["## Rollout plan\nStage the migration.", "## Risks\nBackfill volume."],
  comments: [{ author: "Sam", body: "looks good", id: "cmt1", raw: rawComment, tsIso: "2026-05-02T00:00:00.000Z" }],
  id: "pg1",
  raw: rawPage,
  title: "Migration doc",
  tsIso: "2026-05-01T00:00:00.000Z",
  url: "https://notion.so/pg1",
};

const database: NotionDatabaseItem = {
  description: "all tracked services",
  id: "db1",
  raw: rawDatabase,
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

  it("threads raw payloads onto every page chunk, comment, and database record", () => {
    const records = projectNotionRecords({ databases: [database], pages: [page] });
    const chunks = records.filter((r) => r.kind === "page");
    expect(chunks.map((chunk) => chunk.raw)).toEqual([rawPage, rawPage]);
    expect(records.find((r) => r.kind === "comment")!.raw).toEqual(rawComment);
    expect(records.find((r) => r.kind === "database")!.raw).toEqual(rawDatabase);
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

describe("projectNotionRecords — curated attrs (PR4.3)", () => {
  it("lifts relation + mention targets onto the page's chunk-0 record as encoded curated edges", () => {
    const withEdges: NotionPageItem = {
      ...page,
      chunks: ["one section"],
      mentionTargets: ["notion:page:mentioned"],
      relationTargets: ["notion:page:rel1"],
    };
    const record = projectNotionRecords({ databases: [], pages: [withEdges] }).find((r) => r.kind === "page")!;
    expect(record.attrs!["curatedEdges"]).toEqual(["relation|notion:page:rel1", "mention|notion:page:mentioned"]);
  });

  it("keeps file refs as ref-only metadata (no bytes / signed URLs) in attrs.files", () => {
    const withFiles: NotionPageItem = { ...page, chunks: ["s"], fileRefs: ["image (https://cdn/x.png)"] };
    const record = projectNotionRecords({ databases: [], pages: [withFiles] }).find((r) => r.kind === "page")!;
    expect(record.attrs!["files"]).toEqual(["image (https://cdn/x.png)"]);
  });

  it("classifies a status-titled page as status", () => {
    const statusPage: NotionPageItem = { ...page, chunks: ["on track this week"], title: "Weekly update" };
    const record = projectNotionRecords({ databases: [], pages: [statusPage] }).find((r) => r.kind === "page")!;
    expect(record.attrs!["classification"]).toBe("status");
  });

  it("leaves a plain page with no relations/mentions/files untagged", () => {
    const plain: NotionPageItem = { ...page, chunks: ["just some notes"], title: "Notes" };
    const record = projectNotionRecords({ databases: [], pages: [plain] }).find((r) => r.kind === "page")!;
    expect(record.attrs?.["curatedEdges"]).toBe(undefined);
    expect(record.attrs?.["classification"]).toBe(undefined);
  });
});
