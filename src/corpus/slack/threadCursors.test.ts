import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import { latestReplyTs, newerReplies, readThreadCursors, threadKey, writeThreadCursors } from "./threadCursors.js";

function tempHome(): string {
  return join(mkdtempSync(join(tmpdir(), "slopweaver-threads-")), "home");
}

describe("threadKey", () => {
  it("keys by channel + thread ts", () => {
    expect(threadKey({ channel: "C_A", threadTs: "1700000000.000100" })).toBe("C_A:1700000000.000100");
  });
});

describe("newerReplies", () => {
  it("keeps only replies strictly newer than the stored cursor (drops the inclusive boundary)", () => {
    const replies = [{ ts: "1.0" }, { ts: "2.0" }, { ts: "3.0" }];
    expect(newerReplies({ afterTs: "2.0", replies }).map((r) => r.ts)).toEqual(["3.0"]);
  });

  it("returns every reply when there is no stored cursor", () => {
    const replies = [{ ts: "1.0" }, { ts: "2.0" }];
    expect(newerReplies({ afterTs: undefined, replies })).toHaveLength(2);
  });
});

describe("latestReplyTs", () => {
  it("returns the numeric-max ts across the current cursor and new replies", () => {
    expect(latestReplyTs({ current: "1.0", replies: [{ ts: "3.0" }, { ts: "2.0" }] })).toBe("3.0");
  });

  it("keeps the current cursor when there are no newer replies", () => {
    expect(latestReplyTs({ current: "5.0", replies: [] })).toBe("5.0");
  });

  it("is undefined when there is neither a cursor nor a reply", () => {
    expect(latestReplyTs({ current: undefined, replies: [] })).toBeUndefined();
  });
});

describe("read/write round-trip", () => {
  it("persists and reads back the cursor map", () => {
    const home = tempHome();
    unwrap(writeThreadCursors({ cursors: { "C_A:1.1": "2.0", "C_B:3.3": "4.0" }, home }));
    expect(readThreadCursors({ home })).toEqual({ "C_A:1.1": "2.0", "C_B:3.3": "4.0" });
  });

  it("degrades to an empty map when no store exists", () => {
    expect(readThreadCursors({ home: tempHome() })).toEqual({});
  });
});
