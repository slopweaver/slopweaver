import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import {
  fetchSlackActivity,
  mergeCursorUpdates,
  planThreadPolls,
  resolveSlackReadToken,
  type SlackApi,
  selectChannels,
  shapeHistoryPage,
  shapeRepliesPage,
} from "./fetch.js";

const ctx = { channelId: "C_A", channelName: "alpha", workspaceUrl: "https://acme.slack.com" };

describe("resolveSlackReadToken", () => {
  it("prefers the user token (full channel visibility), no warning", () => {
    const resolved = resolveSlackReadToken({ botToken: "xoxb-bot", userToken: "xoxp-user" });
    expect(resolved.token).toBe("xoxp-user");
    expect(resolved.warning).toBeUndefined();
  });

  it("falls back to the bot token with a limited-visibility warning", () => {
    const resolved = resolveSlackReadToken({ botToken: "xoxb-bot", userToken: undefined });
    expect(resolved.token).toBe("xoxb-bot");
    expect(resolved.warning).toContain("bot-invited channels");
    expect(resolved.warning).toContain("SLACK_USER_TOKEN");
  });

  it("resolves no token when neither is configured", () => {
    expect(resolveSlackReadToken({ botToken: undefined, userToken: undefined })).toEqual({});
  });
});

/** Records every `history` call's window bounds, so tests can assert oldest AND latest are threaded. */
interface HistoryCall {
  readonly channel: string;
  readonly oldest: string;
  readonly latest: string;
}

/** A fake Slack seam: two channels (both enumerated regardless of membership), one threaded message. */
function fakeApi({
  calls,
  failChannel,
  replyOldest,
}: {
  calls: HistoryCall[];
  failChannel?: string;
  replyOldest?: string[];
}): SlackApi {
  return {
    history: async ({ channel, oldest, latest }) => {
      calls.push({ channel, latest, oldest });
      if (channel === failChannel) {
        throw new Error("not_in_channel");
      }
      return channel === "C_A"
        ? {
            messages: [
              {
                files: [{ id: "F1", mimetype: "image/png", title: "pic.png", user: "U2" }],
                reactions: [{ count: 2, name: "+1" }],
                reply_count: 1,
                text: "hello team, see #12",
                ts: "1700000000.000100",
                user: "U1",
              },
            ],
          }
        : { messages: [] };
    },
    listChannels: async () => ({
      channels: [
        { id: "C_A", is_member: true, name: "alpha" },
        { id: "C_B", is_member: false, name: "beta" }, // NOT a member — must STILL be enumerated
      ],
    }),
    listUsers: async () => ({
      members: [
        { id: "U1", profile: { display_name: "Ada" }, real_name: "Ada Lovelace" },
        { id: "U2", name: "grace", profile: {} },
      ],
    }),
    replies: async ({ ts, oldest }) => {
      replyOldest?.push(oldest);
      return {
        messages: [
          { text: "parent", ts, user: "U1" },
          { text: "a reply", ts: "1700000100.000200", user: "U2" },
        ],
      };
    },
    workspaceUrl: async () => "https://acme.slack.com",
  };
}

const window = { since: "2023-11-01", until: "2023-12-01" };

describe("fetchSlackActivity", () => {
  it("enumerates EVERY channel (not just member ones) and shapes messages + reactions + files + replies", async () => {
    const result = unwrap(await fetchSlackActivity({ api: fakeApi({ calls: [] }), window }));
    expect(result.channels.map((c) => c.channelId)).toEqual(["C_A", "C_B"]); // C_B kept despite is_member:false
    const channel = result.channels[0]!;
    expect(channel.messages[0]!.reactions).toEqual([":+1: x2"]);
    expect(channel.messages[0]!.files.map((f) => f.id)).toEqual(["F1"]);
    expect(channel.messages[0]!.permalink).toBe("https://acme.slack.com/archives/C_A/p1700000000000100");
    expect(channel.replies).toHaveLength(1);
    expect(channel.replies[0]!.ts).toBe("1700000100.000200");
  });

  it("keeps raw Slack message, reply, and file objects on shaped items", async () => {
    const result = unwrap(await fetchSlackActivity({ api: fakeApi({ calls: [] }), window }));
    const message = result.channels[0]!.messages[0]!;
    const reply = result.channels[0]!.replies[0]!;
    expect(message.raw).toEqual({
      files: [{ id: "F1", mimetype: "image/png", title: "pic.png", user: "U2" }],
      reactions: [{ count: 2, name: "+1" }],
      reply_count: 1,
      text: "hello team, see #12",
      ts: "1700000000.000100",
      user: "U1",
    });
    expect(message.files[0]!.raw).toEqual({ id: "F1", mimetype: "image/png", title: "pic.png", user: "U2" });
    expect(reply.raw).toEqual({ text: "a reply", ts: "1700000100.000200", user: "U2" });
  });

  it("builds the id→name user + channel maps once and captures each file's uploader id", async () => {
    const result = unwrap(await fetchSlackActivity({ api: fakeApi({ calls: [] }), window }));
    expect(result.maps.userNames).toEqual({ U1: "Ada", U2: "grace" }); // display_name wins, else name
    expect(result.maps.channelNames).toEqual({ C_A: "alpha", C_B: "beta" }); // from discovery (every channel)
    expect(result.channels[0]!.messages[0]!.files[0]!.user).toBe("U2"); // uploader id threaded for author resolution
  });

  it("keeps the user directory non-fatal: a users.list failure warns but still returns channels", async () => {
    const api: SlackApi = {
      ...fakeApi({ calls: [] }),
      listUsers: async () => {
        throw new Error("ratelimited");
      },
    };
    const result = unwrap(await fetchSlackActivity({ api, window }));
    expect(result.channels.map((c) => c.channelId)).toEqual(["C_A", "C_B"]);
    expect(result.maps.userNames).toEqual({});
    expect(result.warnings.some((w) => w.includes("user directory unavailable"))).toBe(true);
  });

  it("passes BOTH oldest and latest window bounds to conversations.history", async () => {
    const calls: HistoryCall[] = [];
    await fetchSlackActivity({ api: fakeApi({ calls }), window });
    expect(calls.length).toBeGreaterThan(0);
    // since 2023-11-01 → 1698796800 ; until 2023-12-01 → 1701388800 (epoch seconds)
    expect(calls.every((c) => c.oldest === "1698796800")).toBe(true);
    expect(calls.every((c) => c.latest === "1701388800")).toBe(true);
    expect(calls.every((c) => c.latest !== "" && c.latest !== "9999999999")).toBe(true);
  });

  it("skips an unreadable channel with a warning without sinking the others", async () => {
    const result = unwrap(await fetchSlackActivity({ api: fakeApi({ calls: [], failChannel: "C_A" }), window }));
    expect(result.channels.map((c) => c.channelId)).toEqual(["C_B"]); // C_A skipped, C_B still ingested
    expect(result.warnings.some((w) => w.includes("C_A") && w.includes("not_in_channel"))).toBe(true);
  });

  it("reads a thread's replies incrementally from its stored cursor and advances it", async () => {
    const replyOldest: string[] = [];
    // Stored cursor sits between the parent (…100) and the reply (…200): the reply is new, the cursor advances.
    const cursors = { "C_A:1700000000.000100": "1700000050.000000" };
    const result = unwrap(
      await fetchSlackActivity({ api: fakeApi({ calls: [], replyOldest }), threadCursors: cursors, window }),
    );
    expect(replyOldest).toContain("1700000050.000000"); // replies fetched FROM the stored cursor, not the window
    expect(result.channels[0]!.replies).toHaveLength(1);
    expect(result.threadCursors["C_A:1700000000.000100"]).toBe("1700000100.000200"); // advanced to newest reply
  });

  it("re-polls a KNOWN thread whose parent is OUT of the window (off-window delta still caught)", async () => {
    const replyOldest: string[] = [];
    // C_B's history window returns NO parent, but the store has a cursor for an older thread in C_B.
    const cursors = { "C_B:1699000000.000000": "1699500000.000000" };
    const result = unwrap(
      await fetchSlackActivity({ api: fakeApi({ calls: [], replyOldest }), threadCursors: cursors, window }),
    );
    const cB = result.channels.find((c) => c.channelId === "C_B")!;
    expect(cB.replies.map((r) => r.threadTs)).toContain("1699000000.000000"); // the off-window thread's new reply
    expect(replyOldest).toContain("1699500000.000000"); // fetched FROM the stored cursor, not the window
    expect(result.threadCursors["C_B:1699000000.000000"]).toBe("1700000100.000200"); // cursor advanced
  });

  it("re-reads nothing new when the cursor is already at the latest reply", async () => {
    const cursors = { "C_A:1700000000.000100": "1700000100.000200" };
    const result = unwrap(await fetchSlackActivity({ api: fakeApi({ calls: [] }), threadCursors: cursors, window }));
    expect(result.channels[0]!.replies).toHaveLength(0); // the boundary reply is dropped — nothing new
  });

  it("honours an explicit channel filter", async () => {
    const result = unwrap(
      await fetchSlackActivity({ api: fakeApi({ calls: [] }), channelFilter: ["C_MISSING"], window }),
    );
    expect(result.channels).toHaveLength(0);
  });

  it("is fatal when channel discovery throws", async () => {
    const api: SlackApi = {
      ...fakeApi({ calls: [] }),
      listChannels: async () => {
        throw new Error("missing_scope");
      },
    };
    expect((await fetchSlackActivity({ api, window })).ok).toBe(false);
  });
});

describe("shapeHistoryPage", () => {
  it("shapes a raw message into an item with reactions, files, and a stable permalink", () => {
    const items = shapeHistoryPage({
      ctx,
      messages: [{ files: [{ id: "F1" }], reactions: [{ count: 2, name: "+1" }], ts: "1700000000.000100", user: "U1" }],
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.reactions).toEqual([":+1: x2"]);
    expect(items[0]!.files.map((f) => f.id)).toEqual(["F1"]);
    expect(items[0]!.permalink).toBe("https://acme.slack.com/archives/C_A/p1700000000000100");
    expect(items[0]!.channelName).toBe("alpha");
  });

  it("drops a non-object row and a ts-less row without failing", () => {
    expect(shapeHistoryPage({ ctx, messages: [42, { text: "no ts" }] })).toEqual([]);
  });
});

describe("planThreadPolls", () => {
  it("selects only messages with a positive reply_count", () => {
    const polls = planThreadPolls({
      messages: [
        { reply_count: 3, ts: "1.1" },
        { reply_count: 0, ts: "2.2" },
        { ts: "3.3" },
        { reply_count: 1, ts: "4.4" },
      ],
    });
    expect(polls.map((p) => p.threadTs)).toEqual(["1.1", "4.4"]);
  });
});

describe("shapeRepliesPage", () => {
  it("shapes replies but skips the parent echo (same ts as the thread root)", () => {
    const replies = shapeRepliesPage({
      ctx,
      messages: [
        { text: "parent", ts: "1700000000.000100", user: "U1" },
        { text: "a reply", ts: "1700000100.000200", user: "U2" },
      ],
      threadTs: "1700000000.000100",
    });
    expect(replies).toHaveLength(1);
    expect(replies[0]!.ts).toBe("1700000100.000200");
    expect(replies[0]!.threadTs).toBe("1700000000.000100");
  });
});

describe("selectChannels", () => {
  const discovered = [
    { id: "C_A", name: "alpha" },
    { id: "C_B", name: "beta" },
  ];

  it("returns every discovered channel when there is no filter", () => {
    expect(selectChannels({ channelFilter: undefined, discovered })).toEqual(discovered);
  });

  it("keeps only the allowlisted ids when a filter is given", () => {
    expect(selectChannels({ channelFilter: ["C_B"], discovered }).map((c) => c.id)).toEqual(["C_B"]);
    expect(selectChannels({ channelFilter: ["C_MISSING"], discovered })).toEqual([]);
  });
});

describe("mergeCursorUpdates", () => {
  it("overlays updates onto the base without mutating the base", () => {
    const base = { "C:1": "10", "C:2": "20" };
    const merged = mergeCursorUpdates({ base, updates: { "C:2": "25", "C:3": "30" } });
    expect(merged).toEqual({ "C:1": "10", "C:2": "25", "C:3": "30" });
    expect(base).toEqual({ "C:1": "10", "C:2": "20" }); // base unmutated
  });
});
