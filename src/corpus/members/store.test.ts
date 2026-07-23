import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { unwrap } from "../../lib/result.js";
import {
  freshMemberRows,
  memberFingerprint,
  parseMemberRow,
  readAllMembers,
  readMemberRows,
  writeMemberRows,
} from "./store.js";
import type { MemberBronzeRow } from "./types.js";

function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "slopweaver-members-"));
}

function row({
  nativeId,
  fetchedAtIso = "2026-07-20T00:00:00.000Z",
  title,
}: {
  nativeId: string;
  fetchedAtIso?: string;
  title?: string;
}): MemberBronzeRow {
  return {
    fetchedAtIso,
    identity: {
      email: "ada@example.com",
      emailNormalised: "ada@example.com",
      emailTrust: "trusted",
      handle: "ada",
      name: "Ada",
      nativeId,
      source: "slack",
    },
    profile: { active: true, bot: false, ...(title !== undefined ? { title } : {}) },
    provenance: ["slack.users.list"],
    raw: { deeply: { nested: ["ada@example.com", 42] }, id: nativeId },
    source: "slack",
    sourceId: nativeId,
    version: 1,
    warnings: [],
  };
}

describe("memberFingerprint", () => {
  it("ignores fetchedAtIso, so a time-only re-hydrate collapses", () => {
    expect(memberFingerprint({ row: row({ fetchedAtIso: "2026-01-01T00:00:00.000Z", nativeId: "U1" }) })).toBe(
      memberFingerprint({ row: row({ fetchedAtIso: "2026-12-31T00:00:00.000Z", nativeId: "U1" }) }),
    );
  });

  it("changes when a profile field changes", () => {
    expect(memberFingerprint({ row: row({ nativeId: "U1" }) })).not.toBe(
      memberFingerprint({ row: row({ nativeId: "U1", title: "Staff Engineer" }) }),
    );
  });
});

describe("freshMemberRows", () => {
  it("drops an incoming row whose fingerprint is already stored (only fetchedAtIso differs)", () => {
    const stored = [row({ fetchedAtIso: "2026-01-01T00:00:00.000Z", nativeId: "U1" })];
    const incoming = [row({ fetchedAtIso: "2026-07-20T00:00:00.000Z", nativeId: "U1" })];
    expect(freshMemberRows({ incoming, stored })).toEqual([]);
  });

  it("keeps a genuinely changed row + collapses within-batch dups", () => {
    const fresh = freshMemberRows({
      incoming: [row({ nativeId: "U1", title: "Staff" }), row({ nativeId: "U1", title: "Staff" })],
      stored: [],
    });
    expect(fresh.map((r) => r.sourceId)).toEqual(["U1"]);
  });
});

describe("writeMemberRows + readMemberRows", () => {
  it("round-trips the FULL raw object exactly (nothing projected away)", () => {
    const home = tempHome();
    unwrap(writeMemberRows({ home, rows: [row({ nativeId: "U1" })], source: "slack" }));
    const read = readMemberRows({ home, source: "slack" });
    expect(read.rows[0]!.raw).toEqual({ deeply: { nested: ["ada@example.com", 42] }, id: "U1" });
  });

  it("re-writing the same member is idempotent (deduped, nothing new written)", () => {
    const home = tempHome();
    unwrap(writeMemberRows({ home, rows: [row({ nativeId: "U1" })], source: "slack" }));
    const second = unwrap(
      writeMemberRows({
        home,
        rows: [row({ fetchedAtIso: "2026-08-01T00:00:00.000Z", nativeId: "U1" })],
        source: "slack",
      }),
    );
    expect(second).toEqual({ deduped: 1, written: 0 });
    expect(readMemberRows({ home, source: "slack" }).rows).toHaveLength(1);
  });

  it("appends a new row when a profile field genuinely changed", () => {
    const home = tempHome();
    unwrap(writeMemberRows({ home, rows: [row({ nativeId: "U1" })], source: "slack" }));
    unwrap(writeMemberRows({ home, rows: [row({ nativeId: "U1", title: "Staff Engineer" })], source: "slack" }));
    expect(readMemberRows({ home, source: "slack" }).rows).toHaveLength(2);
  });
});

describe("parseMemberRow", () => {
  it("rejects a row with an unknown source", () => {
    const parsed = parseMemberRow({
      line: JSON.stringify({ identity: {}, profile: {}, source: "jira", sourceId: "x", version: 1 }),
    });
    expect(parsed).toEqual({ error: "unknown member source: jira" });
  });

  it("rejects a row missing a required field", () => {
    const parsed = parseMemberRow({ line: JSON.stringify({ source: "slack", sourceId: "U1", version: 2 }) });
    expect(parsed).toEqual({ error: "missing required member field (version/sourceId/identity/profile)" });
  });
});

describe("readAllMembers", () => {
  it("aggregates every source's rows and surfaces a corrupt line as a labelled warning", () => {
    const home = tempHome();
    unwrap(writeMemberRows({ home, rows: [row({ nativeId: "U1" })], source: "slack" }));
    const all = readAllMembers({ home });
    expect(all.rows.map((r) => r.sourceId)).toEqual(["U1"]);
    expect(all.warnings).toEqual([]);
  });
});
