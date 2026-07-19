import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unwrap } from "../lib/result.js";
import { bronzeSourceDir } from "./corpusPaths.js";
import { readCorpusDir } from "./corpusStore.js";
import { serialiseRecord, writeCorpusRecords } from "./corpusWriter.js";
import type { CorpusRecord, ExportWindow } from "./types.js";

const window: ExportWindow = { since: "2024-01-01", until: "2024-01-03" };
const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "hi",
  tsIso: "2024-01-02T00:00:00Z",
  url: "u",
  ...over,
});

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slop-writer-"));
});
afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

describe("writeCorpusRecords", () => {
  it("writes new records and redacts their text on disk", () => {
    const result = writeCorpusRecords({ home, records: [rec({ text: "ping a@b.co" })], window });
    expect(unwrap(result).written).toBe(1);
    const back = readCorpusDir({ dir: bronzeSourceDir({ home, source: "github" }) });
    expect(unwrap(back)[0]!.text).toBe("ping [email]");
  });

  it("is idempotent — re-writing identical records dedups them", () => {
    writeCorpusRecords({ home, records: [rec()], window });
    const again = writeCorpusRecords({ home, records: [rec()], window });
    expect(unwrap(again)).toMatchObject({ deduped: 1, written: 0 });
  });

  it("writes a genuine update but drops a stale (older) re-fetch", () => {
    writeCorpusRecords({ home, records: [rec({ text: "v1", tsIso: "2024-01-02T00:00:00Z" })], window });
    const updated = writeCorpusRecords({ home, records: [rec({ text: "v2", tsIso: "2024-01-03T00:00:00Z" })], window });
    expect(unwrap(updated).written).toBe(1);
    const stale = writeCorpusRecords({ home, records: [rec({ text: "v0", tsIso: "2024-01-01T00:00:00Z" })], window });
    expect(unwrap(stale).written).toBe(0);
  });

  it("serialises attrs with sorted keys (stable fingerprint regardless of insertion order)", () => {
    const line = serialiseRecord({ record: rec({ attrs: { alpha: "a", middle: 2, zebra: "z" } }) });
    expect(line).toContain('"attrs":{"alpha":"a","middle":2,"zebra":"z"}');
  });

  it("redacts string attr values before writing (a secret can hide in metadata)", () => {
    writeCorpusRecords({ home, records: [rec({ attrs: { contact: "ping a@b.co" } })], window });
    const back = readCorpusDir({ dir: bronzeSourceDir({ home, source: "github" }) });
    expect(unwrap(back)[0]!.attrs).toEqual({ contact: "ping [email]" });
  });

  it("treats an attr-only change as a genuine update (attrs are in the fingerprint)", () => {
    writeCorpusRecords({ home, records: [rec({ attrs: { state: "open" } })], window });
    const changed = writeCorpusRecords({ home, records: [rec({ attrs: { state: "closed" } })], window });
    expect(unwrap(changed).written).toBe(1);
    const noChange = writeCorpusRecords({ home, records: [rec({ attrs: { state: "closed" } })], window });
    expect(unwrap(noChange).written).toBe(0);
  });

  it("stays dedup-compatible with pre-attrs records (no forced re-fetch)", () => {
    writeCorpusRecords({ home, records: [rec()], window }); // written without attrs
    const again = writeCorpusRecords({ home, records: [rec()], window });
    expect(unwrap(again)).toMatchObject({ deduped: 1, written: 0 });
  });

  it("redacts string leaves ANYWHERE in the raw payload (nested + arrays), keeping all fields", () => {
    const raw = { author: { email: "a@b.co" }, notes: ["ping c@d.co", "clean"], number: 7 };
    writeCorpusRecords({ home, records: [rec({ raw })], window });
    const back = unwrap(readCorpusDir({ dir: bronzeSourceDir({ home, source: "github" }) }))[0]!;
    expect(back.raw).toEqual({ author: { email: "[email]" }, notes: ["ping [email]", "clean"], number: 7 });
  });

  it("excludes raw from the dedup fingerprint — a raw-only change does NOT churn bronze", () => {
    writeCorpusRecords({ home, records: [rec({ raw: { v: 1 } })], window });
    const rawChanged = writeCorpusRecords({ home, records: [rec({ raw: { v: 2 } })], window });
    expect(unwrap(rawChanged)).toMatchObject({ deduped: 1, written: 0 }); // same content ⇒ no new line
  });
});
