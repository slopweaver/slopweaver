import { describe, expect, it } from "vitest";
import type { CorpusRecord } from "../../../corpus/types.js";
import type { IdentityRecord } from "../../../silver/identity.js";
import { EXIT_EXPECTED_EMPTY, EXIT_OK, EXIT_USAGE } from "../../exitCodes.js";
import { type IdentityDeps, runIdentityResolveWithDeps, runIdentityShowWithDeps } from "./run.js";

const rec = (over: Partial<CorpusRecord> = {}): CorpusRecord => ({
  container: "o/r",
  kind: "pr",
  refs: [],
  source: "github",
  sourceId: "#1",
  text: "t",
  tsIso: "2026-05-01T00:00:00Z",
  url: "u",
  ...over,
});

const RECORDS: readonly CorpusRecord[] = [
  rec({ author: "ada", source: "github", sourceId: "gh1" }),
  rec({ author: "U1", container: "slack/c", source: "slack", sourceId: "s1" }),
];

const ROSTER: readonly IdentityRecord[] = [
  {
    handle: "ada",
    id: "person:ada",
    identities: [
      { nativeId: "ada", source: "github" },
      { nativeId: "U1", source: "slack" },
    ],
    name: "Ada Lovelace",
  },
];

/** A capturing fake — plain functions, not mocks (per testing.md). */
function fakeDeps({
  records = RECORDS,
  roster = ROSTER,
}: {
  records?: readonly CorpusRecord[];
  roster?: readonly IdentityRecord[];
} = {}): { deps: IdentityDeps; out: string[]; err: string[]; loads: () => number } {
  const out: string[] = [];
  const err: string[] = [];
  let loads = 0;
  const deps: IdentityDeps = {
    home: () => "/home",
    loadRecords: () => {
      loads += 1;
      return { records, warnings: [] };
    },
    loadRoster: () => roster,
    logger: {
      error: (m) => err.push(m),
      out: (m) => out.push(m),
      warn: () => {},
    },
  };
  return { deps, err, loads: () => loads, out };
}

const argv = (tail: readonly string[]): readonly string[] => ["node", "cli", "identity", ...tail];

describe("identity show", () => {
  it("lists the merged canonical person", () => {
    const { deps, out } = fakeDeps();
    const code = runIdentityShowWithDeps({ argv: argv(["show"]), deps });
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toBe("person:ada  [override]  Ada Lovelace");
  });

  it("emits deterministic --json for the whole resolution", () => {
    const { deps, out } = fakeDeps();
    runIdentityShowWithDeps({ argv: argv(["show", "--json"]), deps });
    const parsed = JSON.parse(out.join("\n")) as { people: { id: string }[] };
    expect(parsed.people.map((p) => p.id)).toEqual(["person:ada"]);
  });

  it("filters to one person when given a positional (the `show <me>` proof shape)", () => {
    const { deps, out } = fakeDeps();
    const code = runIdentityShowWithDeps({ argv: argv(["show", "U1"]), deps });
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toBe("person:ada  [override]  Ada Lovelace");
  });

  it("signals not-found (EXIT_EXPECTED_EMPTY) for an unknown positional", () => {
    const { deps, out } = fakeDeps();
    const code = runIdentityShowWithDeps({ argv: argv(["show", "nobody"]), deps });
    expect(code).toBe(EXIT_EXPECTED_EMPTY);
    expect(out[0]).toBe('no canonical person for "nobody"');
  });

  it("rejects an unknown flag WITHOUT loading the corpus (parse reject is I/O-free)", () => {
    const { deps, loads } = fakeDeps();
    const code = runIdentityShowWithDeps({ argv: argv(["show", "--bogus"]), deps });
    expect(code).toBe(EXIT_USAGE);
    expect(loads()).toBe(0);
  });

  it("prints usage on --help without loading the corpus", () => {
    const { deps, out, loads } = fakeDeps();
    const code = runIdentityShowWithDeps({ argv: argv(["show", "--help"]), deps });
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toContain("usage: slopweaver identity show");
    expect(loads()).toBe(0);
  });
});

describe("identity resolve", () => {
  it("resolves a raw id to its canonical person", () => {
    const { deps, out } = fakeDeps();
    const code = runIdentityResolveWithDeps({ argv: argv(["resolve", "@ada"]), deps });
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toBe("person:ada  [override]  Ada Lovelace");
  });

  it("signals not-found for an unknown token", () => {
    const { deps, out } = fakeDeps();
    const code = runIdentityResolveWithDeps({ argv: argv(["resolve", "ghost"]), deps });
    expect(code).toBe(EXIT_EXPECTED_EMPTY);
    expect(out[0]).toBe('no canonical person for "ghost"');
  });

  it("rejects a missing positional as a usage error, I/O-free", () => {
    const { deps, loads } = fakeDeps();
    const code = runIdentityResolveWithDeps({ argv: argv(["resolve"]), deps });
    expect(code).toBe(EXIT_USAGE);
    expect(loads()).toBe(0);
  });

  it("still resolves within a source when the roster is empty (single-source)", () => {
    const { deps, out } = fakeDeps({ roster: [] });
    const code = runIdentityResolveWithDeps({ argv: argv(["resolve", "ada"]), deps });
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toBe("person:github:ada  [single-source]  ada");
  });
});
