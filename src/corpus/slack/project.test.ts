import { describe, expect, it } from "vitest";
import { projectSlackRecords, resolveSlackMarkup, type SlackChannelItems, type SlackNameMaps } from "./project.js";

const maps: SlackNameMaps = {
  channelNames: { C_PUBLIC_ALPHA: "alpha", C_RELEASES: "releases" },
  userNames: { U_UPLOADER: "Linus", U1: "Ada", U2: "Grace" },
};

const rawMessage = { rawMarker: "slack-message", text: "shipping the alpha release, see #123" };
const rawReply = { rawMarker: "slack-reply", text: "nice, merging now" };
const rawFile = { id: "F1", rawMarker: "slack-file", title: "diagram.png" };

const channel: SlackChannelItems = {
  channelId: "C_PUBLIC_ALPHA",
  channelName: "alpha",
  messages: [
    {
      author: "U1",
      channelId: "C_PUBLIC_ALPHA",
      channelName: "alpha",
      files: [{ id: "F1", mimetype: "image/png", raw: rawFile, title: "diagram.png" }],
      permalink: "https://acme.slack.com/archives/C_PUBLIC_ALPHA/p1700000000000100",
      raw: rawMessage,
      reactions: [":+1: x2"],
      text: "shipping the alpha release, see #123",
      ts: "1700000000.000100",
      tsIso: "2023-11-14T22:13:20.000Z",
    },
  ],
  replies: [
    {
      author: "U2",
      channelId: "C_PUBLIC_ALPHA",
      channelName: "alpha",
      files: [],
      permalink: "https://acme.slack.com/archives/C_PUBLIC_ALPHA/p1700000100000200",
      raw: rawReply,
      text: "nice, merging now",
      threadTs: "1700000000.000100",
      ts: "1700000100.000200",
      tsIso: "2023-11-14T22:15:00.000Z",
    },
  ],
};

describe("projectSlackRecords", () => {
  it("projects a message to a `message` record with a channel-scoped id, permalink, and reactions/files folded in", () => {
    const records = projectSlackRecords({ channels: [channel] });
    const message = records.find((r) => r.kind === "message")!;
    expect(message.sourceId).toBe("C_PUBLIC_ALPHA:1700000000.000100");
    expect(message.source).toBe("slack");
    expect(message.container).toBe("slack/C_PUBLIC_ALPHA");
    expect(message.url).toBe("https://acme.slack.com/archives/C_PUBLIC_ALPHA/p1700000000000100");
    expect(message.author).toBe("U1");
    expect(message.text).toContain("shipping the alpha release");
    expect(message.text).toContain("Reactions: :+1: x2");
    expect(message.text).toContain("Attachments: diagram.png");
    expect(message.refs).toContain("#123");
  });

  it("threads raw payloads onto message, reply, and file records", () => {
    const records = projectSlackRecords({ channels: [channel] });
    expect(records.find((r) => r.kind === "message")!.raw).toEqual(rawMessage);
    expect(records.find((r) => r.kind === "comment")!.raw).toEqual(rawReply);
    expect(records.find((r) => r.kind === "file")!.raw).toEqual(rawFile);
  });

  it("projects a thread reply to a `comment` record keyed by thread + reply ts", () => {
    const records = projectSlackRecords({ channels: [channel] });
    const reply = records.find((r) => r.kind === "comment")!;
    expect(reply.sourceId).toBe("C_PUBLIC_ALPHA:1700000000.000100:reply:1700000100.000200");
    expect(reply.text).toBe("nice, merging now");
    expect(reply.author).toBe("U2");
  });

  it("projects an image/file attachment to a ref-only `file` record (no bytes, cites the message)", () => {
    const records = projectSlackRecords({ channels: [channel] });
    const file = records.find((r) => r.kind === "file")!;
    expect(file.sourceId).toBe("C_PUBLIC_ALPHA:1700000000.000100:file:F1");
    expect(file.title).toBe("diagram.png");
    expect(file.text).toBe("File: diagram.png · image/png");
    expect(file.url).toBe("https://acme.slack.com/archives/C_PUBLIC_ALPHA/p1700000000000100");
  });

  it("resolves user/channel markup in message + comment text via the id→name maps", () => {
    const withMarkup: SlackChannelItems = {
      channelId: "C_PUBLIC_ALPHA",
      channelName: "alpha",
      messages: [
        {
          channelId: "C_PUBLIC_ALPHA",
          channelName: "alpha",
          files: [],
          permalink: "p1",
          reactions: [],
          text: "hey <@U2> see <#C_RELEASES> and <https://x.test|the doc>",
          ts: "1700000000.000100",
          tsIso: "2023-11-14T22:13:20.000Z",
        },
      ],
      replies: [
        {
          channelId: "C_PUBLIC_ALPHA",
          channelName: "alpha",
          files: [],
          permalink: "p2",
          text: "cc <@U_UNKNOWN>",
          threadTs: "1700000000.000100",
          ts: "1700000100.000200",
          tsIso: "2023-11-14T22:15:00.000Z",
        },
      ],
    };
    const records = projectSlackRecords({ channels: [withMarkup], maps });
    const message = records.find((r) => r.kind === "message")!;
    expect(message.text).toBe("hey @Grace see #releases and the doc");
    const reply = records.find((r) => r.kind === "comment")!;
    expect(reply.text).toBe("cc @user");
  });

  it("resolves a file uploader id to the record author via the user map", () => {
    const records = projectSlackRecords({
      channels: [
        {
          channelId: "C_X",
          messages: [
            {
              channelId: "C_X",
              files: [{ id: "F9", title: "spec.pdf", user: "U_UPLOADER" }],
              permalink: "u",
              reactions: [],
              ts: "1.1",
              tsIso: "2023-01-01T00:00:00.000Z",
            },
          ],
          replies: [],
        },
      ],
      maps,
    });
    const file = records.find((r) => r.kind === "file")!;
    expect(file.author).toBe("Linus");
  });

  it("falls back to an empty-message label when a message has no text and no files", () => {
    const records = projectSlackRecords({
      channels: [
        {
          channelId: "C_X",
          messages: [
            {
              channelId: "C_X",
              files: [],
              permalink: "u",
              reactions: [],
              ts: "1.1",
              tsIso: "2023-01-01T00:00:00.000Z",
            },
          ],
          replies: [],
        },
      ],
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.text).toBe("(empty message in C_X)");
  });
});

describe("resolveSlackMarkup", () => {
  it("resolves a known user mention to @DisplayName", () => {
    expect(resolveSlackMarkup({ maps, text: "ping <@U1> now" })).toBe("ping @Ada now");
  });

  it("renders @user (never the raw id) on a user-map miss with no pipe label", () => {
    expect(resolveSlackMarkup({ maps, text: "ping <@U_MISSING>" })).toBe("ping @user");
  });

  it("resolves a known channel mention to #channel-name", () => {
    expect(resolveSlackMarkup({ maps, text: "in <#C_RELEASES>" })).toBe("in #releases");
  });

  it("renders #channel (never the raw id) on a channel-map miss", () => {
    expect(resolveSlackMarkup({ maps, text: "in <#C_MISSING>" })).toBe("in #channel");
  });

  it("prefers the pipe label over a generic fallback when the id is unknown", () => {
    expect(resolveSlackMarkup({ maps, text: "<@U_X|bob> and <#C_Y|random>" })).toBe("@bob and #random");
  });

  it("renders a <url|label> link as its label and a bare <url> as the url", () => {
    expect(resolveSlackMarkup({ maps, text: "<https://x.test|docs> or <https://y.test>" })).toBe(
      "docs or https://y.test",
    );
  });

  it("renders a broadcast special mention as @here", () => {
    expect(resolveSlackMarkup({ maps, text: "<!here> heads up" })).toBe("@here heads up");
  });

  it("leaves plain text untouched", () => {
    expect(resolveSlackMarkup({ maps, text: "no markup, just #123 and @nobody" })).toBe(
      "no markup, just #123 and @nobody",
    );
  });
});
