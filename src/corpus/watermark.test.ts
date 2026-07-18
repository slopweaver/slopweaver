import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { advanceWatermark, computeSourceWatermarks, readWatermark, resolveSince } from "./watermark.js";

describe("computeSourceWatermarks", () => {
  it("takes the max observed tsIso per source", () => {
    const marks = computeSourceWatermarks({
      fallbackUntil: "2024-01-09",
      records: [
        { source: "github", tsIso: "2024-01-02T00:00:00Z" },
        { source: "github", tsIso: "2024-01-05T00:00:00Z" },
      ],
    });
    expect(marks).toEqual([{ cursor: "2024-01-05T00:00:00Z", source: "github" }]);
  });
});

describe("resolveSince", () => {
  it("slices a cursor to a date, else uses the fallback", () => {
    expect(resolveSince({ cursor: "2024-01-05T09:30:00Z", fallbackSince: "fb" })).toBe("2024-01-05");
    expect(resolveSince({ cursor: undefined, fallbackSince: "fb" })).toBe("fb");
  });
});

describe("advanceWatermark", () => {
  let home: string;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "slop-wm-"));
  });
  afterEach(() => {
    rmSync(home, { force: true, recursive: true });
  });

  it("persists a cursor and never regresses it (MAX merge)", () => {
    advanceWatermark({ home, watermarks: [{ cursor: "2024-01-05T00:00:00Z", source: "github" }] });
    expect(readWatermark({ home, source: "github" })).toBe("2024-01-05T00:00:00Z");
    advanceWatermark({ home, watermarks: [{ cursor: "2024-01-03T00:00:00Z", source: "github" }] });
    expect(readWatermark({ home, source: "github" })).toBe("2024-01-05T00:00:00Z");
  });
});
