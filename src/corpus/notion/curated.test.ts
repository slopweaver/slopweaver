import { describe, expect, it } from "vitest";
import { blockFileRef, extractFilePropertyRefs, extractMentions, extractRelationTargets } from "./curated.js";

describe("extractRelationTargets", () => {
  it("captures relation target ids as node keys, not the old 'N linked' count", () => {
    const properties = {
      "Blocked by": { relation: [{ id: "aaa" }, { id: "bbb" }], type: "relation" },
      Name: { title: [], type: "title" },
    };
    expect(extractRelationTargets({ properties })).toEqual(["notion:page:aaa", "notion:page:bbb"]);
  });

  it("dedupes repeated targets and ignores non-relation properties", () => {
    const properties = {
      Related: { relation: [{ id: "aaa" }, { id: "aaa" }], type: "relation" },
      Status: { status: { name: "Done" }, type: "status" },
    };
    expect(extractRelationTargets({ properties })).toEqual(["notion:page:aaa"]);
  });

  it("returns empty for a row with no relations", () => {
    expect(extractRelationTargets({ properties: { Name: { title: [], type: "title" } } })).toEqual([]);
  });
});

describe("extractMentions — explicit-tag only", () => {
  it("captures a page mention as a node key", () => {
    const richText = [{ mention: { page: { id: "p1" }, type: "page" }, plain_text: "the doc", type: "mention" }];
    expect(extractMentions({ richText })).toEqual(["notion:page:p1"]);
  });

  it("captures database and user mentions", () => {
    const richText = [
      { mention: { database: { id: "d1" }, type: "database" }, type: "mention" },
      { mention: { type: "user", user: { id: "u1" } }, type: "mention" },
    ];
    expect(extractMentions({ richText })).toEqual(["notion:database:d1", "notion:user:u1"]);
  });

  it("never treats a plain-text span (a fuzzy name) as a mention", () => {
    const richText = [{ plain_text: "Alfred Pennyworth", type: "text" }];
    expect(extractMentions({ richText })).toEqual([]);
  });

  it("skips date and link_preview mentions that carry no record target", () => {
    const richText = [
      { mention: { date: { start: "2026-01-01" }, type: "date" }, type: "mention" },
      { mention: { link_preview: { url: "https://x" }, type: "link_preview" }, type: "mention" },
    ];
    expect(extractMentions({ richText })).toEqual([]);
  });
});

describe("blockFileRef — ref-only, no signed URLs", () => {
  it("keeps an external image url (stable, author-provided)", () => {
    const block = { image: { external: { url: "https://cdn/x.png" }, type: "external" }, type: "image" };
    expect(blockFileRef({ block })).toBe("image (https://cdn/x.png)");
  });

  it("drops a Notion-hosted (signed, expiring) file url, keeping only the name", () => {
    const block = {
      file: {
        file: { expiry_time: "2026-01-01", url: "https://notion-signed/expiring" },
        name: "plan.pdf",
        type: "file",
      },
      type: "file",
    };
    expect(blockFileRef({ block })).toBe("file: plan.pdf");
  });

  it("keeps an embed url", () => {
    expect(blockFileRef({ block: { embed: { url: "https://figma/design" }, type: "embed" } })).toBe(
      "embed (https://figma/design)",
    );
  });

  it("returns undefined for a non-file block", () => {
    expect(blockFileRef({ block: { paragraph: { rich_text: [] }, type: "paragraph" } })).toBe(undefined);
  });
});

describe("extractFilePropertyRefs", () => {
  it("keeps external file-property urls and drops signed internal ones", () => {
    const properties = {
      Attachments: {
        files: [
          { external: { url: "https://cdn/spec.pdf" }, name: "spec.pdf", type: "external" },
          { file: { url: "https://notion-signed/expiring" }, name: "internal.png", type: "file" },
        ],
        type: "files",
      },
    };
    expect(extractFilePropertyRefs({ properties })).toEqual([
      "file: spec.pdf (https://cdn/spec.pdf)",
      "file: internal.png",
    ]);
  });
});
