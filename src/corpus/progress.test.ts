import { describe, expect, it } from "vitest";
import { previewSnippet, sourceHeartbeat, sourcePreview, toRichProgressEvent } from "./progress.js";

describe("previewSnippet (pure, redaction-safe)", () => {
  it("collapses whitespace and keeps a short snippet whole", () => {
    expect(previewSnippet({ text: "we   should\n\nship   the fix" })).toBe("we should ship the fix");
  });

  it("caps a long snippet with an ellipsis", () => {
    expect(previewSnippet({ maxChars: 10, text: "abcdefghijklmnop" })).toBe("abcdefghi…");
  });

  it("redacts a leaked token before it can reach a progress line", () => {
    // Assemble the token-shaped string at RUNTIME so the source literal never trips the repo hygiene gate.
    const leaked = `xoxb-${"9".repeat(12)}-${"a".repeat(16)}`;
    const snippet = previewSnippet({ text: `here is the key ${leaked} please rotate` });
    expect(snippet.includes("xoxb-")).toBe(false);
    expect(snippet).toBe("here is the key [token] please rotate");
  });

  it("redacts an email address in the preview", () => {
    expect(previewSnippet({ text: "ping person@example.com about it" })).toBe("ping [email] about it");
  });
});

describe("sourceHeartbeat / sourcePreview builders (pure)", () => {
  it("builds a heartbeat with only the present fields", () => {
    expect(
      sourceHeartbeat({
        currentItem: { title: "#eng" },
        done: 3,
        metrics: { messages: 9 },
        phase: "channel",
        source: "slack",
        total: 12,
      }),
    ).toEqual({
      currentItem: { title: "#eng" },
      done: 3,
      lane: "heartbeat",
      metrics: { messages: 9 },
      phase: "channel",
      source: "slack",
      total: 12,
    });
  });

  it("builds a content-preview whose snippet is already redacted", () => {
    const key = `sk-${"a".repeat(28)}`; // assembled at runtime so the source literal never trips hygiene
    const event = sourcePreview({
      phase: "channel",
      snippet: `token ${key} here`,
      source: "slack",
      sourceContentId: "chan-eng",
      subject: "#eng",
    });
    expect(event.lane).toBe("content_preview");
    expect(event.preview!.snippet).toBe("token [token] here");
    expect(event.preview!.subject).toBe("#eng");
    expect(event.preview!.sourceContentId).toBe("chan-eng");
  });
});

describe("toRichProgressEvent (pure bridge)", () => {
  it("namespaces the phase as source.phase and carries the counts through", () => {
    expect(
      toRichProgressEvent({
        event: {
          currentItem: { title: "#eng" },
          done: 3,
          lane: "heartbeat",
          metrics: { messages: 9 },
          phase: "channel",
          source: "slack",
          total: 12,
        },
      }),
    ).toEqual({
      currentItem: { title: "#eng" },
      done: 3,
      lane: "heartbeat",
      metrics: { messages: 9 },
      phase: "slack.channel",
      total: 12,
    });
  });

  it("carries a preview through unchanged", () => {
    const event = toRichProgressEvent({
      event: {
        lane: "content_preview",
        phase: "pages",
        preview: { snippet: "hi", sourceContentId: "P1", subject: "Roadmap" },
        source: "notion",
      },
    });
    expect(event.phase).toBe("notion.pages");
    expect(event.preview).toEqual({ snippet: "hi", sourceContentId: "P1", subject: "Roadmap" });
  });
});
