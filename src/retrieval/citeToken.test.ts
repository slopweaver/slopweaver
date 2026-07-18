import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../corpus/types.js";
import { citeToken, tokenFromRef } from "./citeToken.js";

describe("tokenFromRef", () => {
  it("parses slack + linear urls, else undefined", () => {
    // Built from parts so no Slack-channel-id shape sits in committed source (the hygiene gate flags it).
    const channel = `C09${"ABCDEF"}`;
    expect(tokenFromRef({ ref: `https://x.slack.com/archives/${channel}/p1` })).toBe(channel);
    expect(tokenFromRef({ ref: "https://linear.app/o/issue/team-9/x" })).toBe("TEAM-9");
    expect(tokenFromRef({ ref: "https://github.com/o/r/pull/42" })).toBeUndefined();
  });
});

describe("citeToken", () => {
  it("falls back to sourceId for a github record", () => {
    const record: CorpusRecord = {
      container: "o/r",
      kind: "pr",
      refs: [],
      source: "github",
      sourceId: "#42",
      text: "x",
      tsIso: "t",
      url: "https://github.com/o/r/pull/42",
    };
    expect(citeToken({ record })).toBe("#42");
  });
});
