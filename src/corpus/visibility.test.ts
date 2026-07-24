import { describe, expect, it } from "vitest";

import type { CorpusRecord } from "./types.js";
import { stampVisibility, visibilityForRecord } from "./visibility.js";

const base: CorpusRecord = {
  container: "slack/C_PUBLIC",
  kind: "message",
  refs: [],
  source: "slack",
  sourceId: "C_PUBLIC:1700000000.000100",
  text: "standup notes",
  tsIso: "2026-01-02T00:00:00.000Z",
  url: "https://example.com/r/1",
};

describe("stampVisibility", () => {
  it("stamps a private-lane record with visibility private", () => {
    const stamped = stampVisibility({ record: base, visibility: "private" });
    expect(stamped.visibility).toBe("private");
  });

  it("leaves a public record unchanged (no visibility field added)", () => {
    const stamped = stampVisibility({ record: base, visibility: "public" });
    expect(stamped.visibility).toBeUndefined();
    expect(stamped).toEqual(base);
  });

  it("preserves every other field when stamping private", () => {
    const stamped = stampVisibility({ record: base, visibility: "private" });
    expect(stamped).toEqual({ ...base, visibility: "private" });
  });
});

describe("visibilityForRecord", () => {
  it("reads an explicit private mark as private", () => {
    expect(visibilityForRecord({ record: { ...base, visibility: "private" } })).toBe("private");
  });

  it("reads an unmarked legacy record as public (migration default)", () => {
    expect(visibilityForRecord({ record: base })).toBe("public");
  });

  it("reads an explicit public mark as public", () => {
    expect(visibilityForRecord({ record: { ...base, visibility: "public" } })).toBe("public");
  });
});
