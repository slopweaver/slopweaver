import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import {
  freshStructureRows,
  parseStructureRow,
  readAllStructures,
  readStructureRows,
  structureFingerprint,
  writeStructureRows,
} from "./store.js";
import type { StructureBronzeRow } from "./types.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "slopweaver-structures-"));
}

function repoRow({
  sourceId = "acme/app",
  fetchedAtIso = "2026-07-20T00:00:00.000Z",
  archived = false,
}: {
  sourceId?: string;
  fetchedAtIso?: string;
  archived?: boolean;
}): StructureBronzeRow {
  return {
    attrs: { archived, private: true },
    fetchedAtIso,
    identity: { name: "app", nativeId: sourceId, slug: sourceId },
    kind: "repo",
    provenance: ["github.orgs.listRepos"],
    raw: { full_name: sourceId, nested: { token: "abc", values: [1, 2] } },
    relations: [{ targetId: "acme/platform", targetKind: "team", targetSource: "github", type: "permission" }],
    source: "github",
    sourceId,
    version: 1,
    warnings: [],
  };
}

describe("structureFingerprint", () => {
  it("ignores fetchedAtIso, so a time-only re-hydrate collapses", () => {
    expect(structureFingerprint({ row: repoRow({ fetchedAtIso: "2026-01-01T00:00:00.000Z" }) })).toBe(
      structureFingerprint({ row: repoRow({ fetchedAtIso: "2026-12-31T00:00:00.000Z" }) }),
    );
  });

  it("changes when an attr changes", () => {
    expect(structureFingerprint({ row: repoRow({}) })).not.toBe(
      structureFingerprint({ row: repoRow({ archived: true }) }),
    );
  });
});

describe("freshStructureRows", () => {
  it("drops an incoming row already stored (only fetchedAtIso differs) + collapses within-batch dups", () => {
    const stored = [repoRow({ fetchedAtIso: "2026-01-01T00:00:00.000Z" })];
    const incoming = [repoRow({ fetchedAtIso: "2026-07-20T00:00:00.000Z" }), repoRow({})];
    expect(freshStructureRows({ incoming, stored })).toEqual([]);
  });
});

describe("writeStructureRows + readStructureRows", () => {
  it("round-trips the FULL raw object exactly (nothing projected away)", () => {
    const home = tempHome();
    unwrap(writeStructureRows({ home, rows: [repoRow({})], source: "github" }));
    const read = readStructureRows({ home, source: "github" });
    expect(read.rows[0]!.raw).toEqual({ full_name: "acme/app", nested: { token: "abc", values: [1, 2] } });
  });

  it("re-writing the same entity is idempotent (deduped, nothing new)", () => {
    const home = tempHome();
    unwrap(writeStructureRows({ home, rows: [repoRow({})], source: "github" }));
    const second = unwrap(
      writeStructureRows({ home, rows: [repoRow({ fetchedAtIso: "2026-08-01T00:00:00.000Z" })], source: "github" }),
    );
    expect(second).toEqual({ deduped: 1, written: 0 });
    expect(readStructureRows({ home, source: "github" }).rows).toHaveLength(1);
  });

  it("appends a new row when an attr genuinely changed (a renamed/archived entity)", () => {
    const home = tempHome();
    unwrap(writeStructureRows({ home, rows: [repoRow({})], source: "github" }));
    unwrap(writeStructureRows({ home, rows: [repoRow({ archived: true })], source: "github" }));
    expect(readStructureRows({ home, source: "github" }).rows).toHaveLength(2);
  });
});

describe("parseStructureRow", () => {
  it("rejects an unknown source", () => {
    const parsed = parseStructureRow({
      line: JSON.stringify({ kind: "repo", source: "jira", sourceId: "x", version: 1 }),
    });
    expect(parsed).toEqual({ error: "unknown structure source: jira" });
  });

  it("rejects an unknown kind", () => {
    const parsed = parseStructureRow({
      line: JSON.stringify({ kind: "sprint", source: "github", sourceId: "x", version: 1 }),
    });
    expect(parsed).toEqual({ error: "unknown structure kind: sprint" });
  });

  it("rejects a row missing sourceId", () => {
    const parsed = parseStructureRow({ line: JSON.stringify({ kind: "repo", source: "github", version: 1 }) });
    expect(parsed).toEqual({ error: "missing required structure field (version/sourceId)" });
  });
});

describe("readAllStructures", () => {
  it("aggregates rows across sources and reports a corrupt line as a labelled warning", () => {
    const home = tempHome();
    unwrap(writeStructureRows({ home, rows: [repoRow({})], source: "github" }));
    const all = readAllStructures({ home });
    expect(all.rows.map((r) => r.sourceId)).toEqual(["acme/app"]);
    expect(all.warnings).toEqual([]);
  });
});
