import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { unwrap } from "../lib/result.js";
import { parseProfile } from "../profile.js";
import { stateHomePaths } from "../stateHome.js";
import { runInit } from "./stateInit.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "slop-init-"));
});
afterEach(() => {
  rmSync(home, { force: true, recursive: true });
});

/** Recursive relative-path + content listing, sorted — for the idempotency round-trip comparison. */
function snapshot({ dir, base = dir }: { dir: string; base?: string }): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).toSorted((a, b) => (a.name < b.name ? -1 : 1))) {
    const full = join(dir, entry.name);
    const rel = full.slice(base.length + 1);
    if (entry.isDirectory()) {
      out.push(`dir  ${rel}`);
      out.push(...snapshot({ base, dir: full }));
    } else {
      out.push(`file ${rel} :: ${readFileSync(full, "utf8")}`);
    }
  }
  return out;
}

describe("runInit", () => {
  it("scaffolds the full layout and seeds valid files", () => {
    const report = runInit({ home });
    const p = stateHomePaths({ home });
    for (const dir of [
      p.corpus.bronze,
      p.corpus.members,
      p.corpus.structures,
      p.corpus.silver,
      p.corpus.gold,
      p.corpus.cache,
      p.beliefs,
      p.ledgers,
      p.modelCache,
      p.secrets,
    ]) {
      expect(existsSync(dir)).toBe(true);
    }
    expect(JSON.parse(readFileSync(p.homeVersion, "utf8"))).toEqual({ version: 1 });
    expect(parseProfile({ value: JSON.parse(readFileSync(p.profileJson, "utf8")) }).ok).toBe(true);
    expect(JSON.parse(readFileSync(p.identityJson, "utf8"))).toEqual([]);
    // Everything below the (pre-existing temp) home root is freshly created on a first run.
    const belowRoot = report.entries.filter((e) => e.path !== report.home).map((e) => e.outcome);
    expect([...new Set(belowRoot)]).toEqual(["created"]);
  });

  it("makes the secrets dir owner-only (0700) — connector tokens are never group/world-readable", () => {
    runInit({ home });
    const p = stateHomePaths({ home });
    // Compare only the permission bits; POSIX-only, but the CI + dev machines are all POSIX.
    expect(statSync(p.secrets).mode & 0o777).toBe(0o700);
  });

  it("tightens a pre-existing loose secrets dir to 0700 on re-run", () => {
    const p = stateHomePaths({ home });
    mkdirSync(p.secrets, { mode: 0o755, recursive: true });
    chmodSync(p.secrets, 0o755);
    runInit({ home });
    expect(statSync(p.secrets).mode & 0o777).toBe(0o700);
  });

  it("is idempotent — a second run creates nothing and leaves the tree byte-identical", () => {
    runInit({ home });
    const before = snapshot({ dir: home });
    const report = runInit({ home });
    const after = snapshot({ dir: home });
    expect(after).toEqual(before);
    expect([...new Set(report.entries.map((e) => e.outcome))]).toEqual(["existed"]);
  });

  it("never overwrites a hand-edited seed file", () => {
    runInit({ home });
    const p = stateHomePaths({ home });
    const edited = { displayName: "Edited", gitNamespace: "octocat", id: "me", schemaVersion: 1, sources: ["github"] };
    writeFileSync(p.profileJson, JSON.stringify(edited), "utf8");
    const mtimeBefore = statSync(p.profileJson).mtimeMs;
    runInit({ home });
    expect(unwrap(parseProfile({ value: JSON.parse(readFileSync(p.profileJson, "utf8")) })).displayName).toBe("Edited");
    expect(statSync(p.profileJson).mtimeMs).toBe(mtimeBefore);
  });
});
