import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import {
  blockChildId,
  blockTextLine,
  chunkText,
  cutoffMs,
  fetchNotionActivity,
  lastEditedOf,
  type NotionApi,
  notionNextCursor,
  projectCommentItem,
  projectDatabaseItem,
  projectRowItem,
  renderProperty,
  renderRichText,
  renderRowProperties,
  withinCutoff,
} from "./fetch.js";

describe("chunkText", () => {
  it("returns no chunks for blank text", () => {
    expect(chunkText({ text: "   \n\n  " })).toEqual([]);
  });

  it("keeps a short doc as a single chunk", () => {
    expect(chunkText({ text: "one\n\ntwo" })).toEqual(["one\n\ntwo"]);
  });

  it("splits on paragraph boundaries when over the cap", () => {
    const chunks = chunkText({ maxChars: 6, text: "aaaa\n\nbbbb\n\ncccc" });
    expect(chunks).toEqual(["aaaa", "bbbb", "cccc"]);
  });
});

describe("renderRichText", () => {
  it("joins plain text and preserves link targets", () => {
    expect(renderRichText({ richText: [{ plain_text: "see " }, { href: "https://x.test", plain_text: "here" }] })).toBe(
      "see here (https://x.test)",
    );
  });

  it("returns empty for a non-array", () => {
    expect(renderRichText({ richText: undefined })).toBe("");
  });
});

describe("renderRowProperties (data-source rows are the actual records)", () => {
  it("extracts the title property and flattens the rest to `Name: value` lines", () => {
    const { title, text } = renderRowProperties({
      properties: {
        Done: { checkbox: false, type: "checkbox" },
        Name: { title: [{ plain_text: "Ship the migration" }], type: "title" },
        Owner: { people: [{ name: "Sam" }, { name: "Dana" }], type: "people" },
        Priority: { select: { name: "High" }, type: "select" },
        Status: { status: { name: "In progress" }, type: "status" },
      },
    });
    expect(title).toBe("Ship the migration");
    expect(text).toContain("Status: In progress");
    expect(text).toContain("Priority: High");
    expect(text).toContain("Owner: Sam, Dana");
    expect(text).not.toContain("Done:"); // an unchecked box renders empty → omitted, never faked
  });
});

describe("projection cores (pure)", () => {
  it("projects a database summary hit (title from properties, url, no cutoff drop)", () => {
    const raw = { id: "db1", last_edited_time: "2026-05-01T00:00:00.000Z", title: [{ plain_text: "Tasks" }], url: "u" };
    expect(lastEditedOf({ raw })).toBe("2026-05-01T00:00:00.000Z");
    const item = projectDatabaseItem({ id: "db1", lastEdited: lastEditedOf({ raw }), raw });
    expect(item.id).toBe("db1");
    expect(item.title).toBe("Tasks");
    expect(item.url).toBe("u");
  });

  it("projects a data-source ROW into a page item (title property + parent + chunks)", () => {
    const raw = {
      id: "row1",
      properties: {
        Name: { title: [{ plain_text: "A task" }], type: "title" },
        Status: { select: { name: "Done" }, type: "select" },
      },
      url: "u",
    };
    const item = projectRowItem({ dataSourceId: "db1", id: "row1", lastEdited: "2026-05-01T00:00:00.000Z", raw });
    expect(item.id).toBe("row1");
    expect(item.parent).toBe("db1");
    expect(item.title).toBe("A task");
    expect(item.chunks.join("\n")).toContain("Status: Done");
  });

  it("shapes a comment and drops an id-less one", () => {
    const comment = projectCommentItem({
      raw: { created_time: "2026-05-02T00:00:00.000Z", id: "c1", rich_text: [{ plain_text: "hi" }] },
    })!;
    expect(comment.id).toBe("c1");
    expect(comment.body).toBe("hi");
    expect(projectCommentItem({ raw: { rich_text: [] } })).toBeUndefined();
  });
});

describe("fetchNotionActivity folds data-source rows into pages", () => {
  it("collects the databases lane's `rows` as page records", async () => {
    const api: NotionApi = {
      databases: async () => ({
        databases: [{ description: "", id: "db1", title: "Tasks", tsIso: "2026-05-01T00:00:00.000Z", url: "u" }],
        rows: [
          {
            chunks: ["Status: Done"],
            comments: [],
            id: "row1",
            parent: "db1",
            title: "A task",
            tsIso: "2026-05-01T00:00:00.000Z",
            url: "u",
          },
        ],
      }),
      pages: async () => ({ pages: [] }),
    };
    const result = unwrap(await fetchNotionActivity({ api, window: { since: "2026-01-01", until: "2026-06-01" } }));
    expect(result.databases.map((d) => d.id)).toEqual(["db1"]);
    expect(result.pages.map((p) => p.id)).toEqual(["row1"]); // the ROW is ingested, not just the summary
  });
});

describe("since cutoff (Notion search has no server-side date filter)", () => {
  it("has no cutoff for the --all epoch date", () => {
    expect(cutoffMs({ since: "1970-01-01" })).toBeUndefined();
    expect(withinCutoff({ cutoff: undefined, lastEdited: "1999-01-01T00:00:00.000Z" })).toBe(true);
  });

  it("keeps results at/after `since` and drops older ones", () => {
    const cutoff = cutoffMs({ since: "2026-04-01" });
    expect(cutoff).toBeGreaterThan(0);
    expect(withinCutoff({ cutoff, lastEdited: "2026-05-01T00:00:00.000Z" })).toBe(true);
    expect(withinCutoff({ cutoff, lastEdited: "2026-01-01T00:00:00.000Z" })).toBe(false);
  });

  it("keeps an undated result defensively (never silently drops)", () => {
    expect(withinCutoff({ cutoff: cutoffMs({ since: "2026-04-01" }), lastEdited: "" })).toBe(true);
  });
});

describe("fetchNotionActivity", () => {
  it("threads `since` to both lanes and aggregates page warnings", async () => {
    const seen: string[] = [];
    const api: NotionApi = {
      databases: async ({ since }) => {
        seen.push(`db:${since}`);
        return { databases: [], rows: [] };
      },
      pages: async ({ since }) => {
        seen.push(`pg:${since}`);
        return { pages: [], warnings: ["notion: comments for page pg1 failed: 403"] };
      },
    };
    const result = unwrap(await fetchNotionActivity({ api, window: { since: "2026-04-01", until: "2026-06-01" } }));
    expect(seen).toContain("pg:2026-04-01");
    expect(seen).toContain("db:2026-04-01");
    expect(result.warnings).toEqual(["notion: comments for page pg1 failed: 403"]);
  });

  it("pages both pages and databases to exhaustion via the injected seam", async () => {
    const api: NotionApi = {
      databases: async ({ cursor }) =>
        cursor === undefined
          ? {
              databases: [
                { description: "", id: "db1", title: "Registry", tsIso: "2026-05-01T00:00:00.000Z", url: "u" },
              ],
              nextCursor: "d2",
              rows: [],
            }
          : {
              databases: [
                { description: "", id: "db2", title: "Roadmap", tsIso: "2026-05-01T00:00:00.000Z", url: "u" },
              ],
              rows: [],
            },
      pages: async ({ cursor }) =>
        cursor === undefined
          ? {
              nextCursor: "p2",
              pages: [
                { chunks: ["a"], comments: [], id: "pg1", title: "One", tsIso: "2026-05-01T00:00:00.000Z", url: "u" },
              ],
            }
          : {
              pages: [
                { chunks: ["b"], comments: [], id: "pg2", title: "Two", tsIso: "2026-05-01T00:00:00.000Z", url: "u" },
              ],
            },
    };
    const result = unwrap(await fetchNotionActivity({ api, window: { since: "2026-01-01", until: "2026-06-01" } }));
    expect(result.pages.map((p) => p.id)).toEqual(["pg1", "pg2"]);
    expect(result.databases.map((d) => d.id)).toEqual(["db1", "db2"]);
  });

  it("is fatal when the seam throws", async () => {
    const api: NotionApi = {
      databases: async () => ({ databases: [], rows: [] }),
      pages: async () => {
        throw new Error("401 unauthorized");
      },
    };
    const result = await fetchNotionActivity({ api, window: { since: "2026-01-01", until: "2026-06-01" } });
    expect(result.ok).toBe(false);
  });
});

describe("renderProperty (dispatch table)", () => {
  it("renders a title/rich_text property via rich text", () => {
    expect(renderProperty({ value: { title: [{ plain_text: "Roadmap" }], type: "title" } })).toBe("Roadmap");
  });

  it("renders a rich_text property with a link as text (url)", () => {
    expect(
      renderProperty({ value: { rich_text: [{ href: "https://x.dev", plain_text: "see" }], type: "rich_text" } }),
    ).toBe("see (https://x.dev)");
  });

  it("renders select and status names", () => {
    expect(renderProperty({ value: { select: { name: "Done" }, type: "select" } })).toBe("Done");
    expect(renderProperty({ value: { status: { name: "In Progress" }, type: "status" } })).toBe("In Progress");
  });

  it("comma-joins multi_select and people names", () => {
    expect(renderProperty({ value: { multi_select: [{ name: "a" }, { name: "b" }], type: "multi_select" } })).toBe(
      "a, b",
    );
    expect(renderProperty({ value: { people: [{ name: "Ada" }], type: "people" } })).toBe("Ada");
  });

  it("renders a number", () => {
    expect(renderProperty({ value: { number: 42, type: "number" } })).toBe("42");
  });

  it("renders checkbox true as yes and false as empty", () => {
    expect(renderProperty({ value: { checkbox: true, type: "checkbox" } })).toBe("yes");
    expect(renderProperty({ value: { checkbox: false, type: "checkbox" } })).toBe("");
  });

  it("renders a date with start and optional end", () => {
    expect(renderProperty({ value: { date: { start: "2026-01-01" }, type: "date" } })).toBe("2026-01-01");
    expect(renderProperty({ value: { date: { end: "2026-01-02", start: "2026-01-01" }, type: "date" } })).toBe(
      "2026-01-01 → 2026-01-02",
    );
  });

  it("renders url/email/phone_number scalar strings", () => {
    expect(renderProperty({ value: { type: "url", url: "https://x.dev" } })).toBe("https://x.dev");
    expect(renderProperty({ value: { email: "a@b.co", type: "email" } })).toBe("a@b.co");
  });

  it("renders a relation as a linked count", () => {
    expect(renderProperty({ value: { relation: [{}, {}], type: "relation" } })).toBe("2 linked");
  });

  it("returns empty for an unknown type or a non-object value", () => {
    expect(renderProperty({ value: { type: "mystery" } })).toBe("");
    expect(renderProperty({ value: 5 })).toBe("");
  });
});

describe("notionNextCursor", () => {
  it("returns the cursor when it is a non-empty string", () => {
    expect(notionNextCursor({ value: "cur" })).toBe("cur");
  });

  it("stops on an empty string, null, or non-string", () => {
    expect(notionNextCursor({ value: "" })).toBeUndefined();
    expect(notionNextCursor({ value: null })).toBeUndefined();
    expect(notionNextCursor({ value: 3 })).toBeUndefined();
  });
});

describe("blockTextLine", () => {
  it("renders the rich text of a typed block body", () => {
    expect(blockTextLine({ block: { paragraph: { rich_text: [{ plain_text: "hi" }] }, type: "paragraph" } })).toBe(
      "hi",
    );
  });

  it("returns empty when the block has no rich-text body", () => {
    expect(blockTextLine({ block: { divider: {}, type: "divider" } })).toBe("");
  });
});

describe("blockChildId", () => {
  it("returns the id when the block has children", () => {
    expect(blockChildId({ block: { has_children: true, id: "b1" } })).toBe("b1");
  });

  it("returns undefined without children or a string id", () => {
    expect(blockChildId({ block: { has_children: false, id: "b1" } })).toBeUndefined();
    expect(blockChildId({ block: { has_children: true } })).toBeUndefined();
  });
});
