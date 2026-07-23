import { describe, expect, it } from "vitest";
import { isCanvasFile, shapeBookmark, shapeCanvasFile, shapePin, slackPermalink } from "./curated.js";

describe("slackPermalink", () => {
  it("builds the stable archives permalink from ts", () => {
    expect(slackPermalink({ channelId: "C1", ts: "1700000000.001", workspaceUrl: "https://acme.slack.com" })).toBe(
      "https://acme.slack.com/archives/C1/p1700000000001",
    );
  });
});

describe("shapePin", () => {
  it("shapes a pinned message with its permalink + author", () => {
    const item = {
      created: 1,
      message: { permalink: "https://acme.slack.com/p1", text: "read this", ts: "1700000000.001", user: "U1" },
    };
    const pin = shapePin({
      authorName: "Sam",
      channelId: "C1",
      channelName: "eng",
      item,
      workspaceUrl: "https://acme.slack.com",
    })!;
    expect(pin.ts).toBe("1700000000.001");
    expect(pin.text).toBe("read this");
    expect(pin.author).toBe("Sam");
    expect(pin.permalink).toBe("https://acme.slack.com/p1");
  });

  it("returns undefined for a non-message (file) pin", () => {
    expect(
      shapePin({ channelId: "C1", item: { file: { id: "F1" }, type: "file" }, workspaceUrl: "https://acme.slack.com" }),
    ).toBe(undefined);
  });
});

describe("shapeBookmark", () => {
  it("shapes a bookmark with its title + link", () => {
    const raw = { date_created: 1700000000, id: "Bk1", link: "https://runbook", title: "Runbook" };
    const bookmark = shapeBookmark({ channelId: "C1", raw })!;
    expect(bookmark.id).toBe("Bk1");
    expect(bookmark.title).toBe("Runbook");
    expect(bookmark.link).toBe("https://runbook");
  });

  it("returns undefined for a link-less bookmark", () => {
    expect(shapeBookmark({ channelId: "C1", raw: { id: "Bk1", title: "x" } })).toBe(undefined);
  });
});

describe("isCanvasFile / shapeCanvasFile — ref-only, no signed URLs", () => {
  it("detects a canvas by filetype", () => {
    expect(isCanvasFile({ file: { filetype: "canvas" } })).toBe(true);
    expect(isCanvasFile({ file: { filetype: "png" } })).toBe(false);
  });

  it("cites the public permalink, never the signed url_private, as the canvas's projected URL", () => {
    const file = {
      created: 1700000000,
      filetype: "canvas",
      id: "F1",
      permalink: "https://acme.slack.com/canvas/F1",
      title: "Plan",
      url_private: "https://files.slack.com/signed",
    };
    const canvas = shapeCanvasFile({ file })!;
    expect(canvas.id).toBe("F1");
    expect(canvas.title).toBe("Plan");
    // the ref-only floor: the projected citation URL is the public permalink, never the signed download.
    expect(canvas.permalink).toBe("https://acme.slack.com/canvas/F1");
  });

  it("drops a non-canvas file", () => {
    expect(shapeCanvasFile({ file: { filetype: "png", id: "F2", permalink: "p" } })).toBe(undefined);
  });
});
