import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import {
  chunkText,
  cutoffMs,
  fetchNotionActivity,
  type NotionApi,
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
