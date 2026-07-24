import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { watermarkPath } from "./corpusPaths.js";
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

  it("keeps each source's cursor in its OWN file — concurrent sources never clobber each other", () => {
    // Two independent advances (what parallel per-source refreshes do). A single shared read-modify-write
    // file would lose one of these to a stale-read clobber; separate per-source files cannot.
    advanceWatermark({ home, watermarks: [{ cursor: "2024-01-05T00:00:00Z", source: "github" }] });
    advanceWatermark({ home, watermarks: [{ cursor: "2024-02-01T00:00:00Z", source: "slack" }] });
    expect(readWatermark({ home, source: "github" })).toBe("2024-01-05T00:00:00Z");
    expect(readWatermark({ home, source: "slack" })).toBe("2024-02-01T00:00:00Z");
  });

  it("reads from the LEGACY combined .watermark.json when no per-source file exists, then the per-source file wins", () => {
    const legacy = watermarkPath({ home });
    mkdirSync(dirname(legacy), { recursive: true });
    writeFileSync(
      legacy,
      JSON.stringify({ sources: { github: { cursor: "2023-12-31T00:00:00Z" } }, version: 1 }),
      "utf8",
    );
    expect(readWatermark({ home, source: "github" })).toBe("2023-12-31T00:00:00Z"); // migrated read
    advanceWatermark({ home, watermarks: [{ cursor: "2024-06-01T00:00:00Z", source: "github" }] });
    expect(readWatermark({ home, source: "github" })).toBe("2024-06-01T00:00:00Z"); // per-source file now wins
  });
});
