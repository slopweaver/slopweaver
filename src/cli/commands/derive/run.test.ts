import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bronzeFile, silverIdentitiesPath } from "../../../corpus/corpusPaths.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { stateHomePaths } from "../../../stateHome.js";
import { EXIT_OK } from "../../exitCodes.js";
import { runDeriveWithDeps } from "./run.js";

const window = { since: "2026-01-01", until: "2026-02-01" };

const BRONZE: readonly CorpusRecord[] = [
  {
    author: "ada",
    container: "acme/web",
    kind: "pr",
    refs: [],
    source: "github",
    sourceId: "acme/web#1",
    text: "a github pr",
    tsIso: "2026-01-10T00:00:00Z",
    url: "https://example.test/1",
  },
  {
    author: "U1",
    container: "slack/c",
    kind: "message",
    refs: [],
    source: "slack",
    sourceId: "s1",
    text: "a slack message",
    tsIso: "2026-01-11T00:00:00Z",
    url: "https://example.test/2",
  },
];

/** A temp home seeded with a two-source bronze corpus + an optional identity.json roster. */
function seedHome({ roster }: { roster?: string }): string {
  const home = mkdtempSync(join(tmpdir(), "slopweaver-derive-"));
  mkdirSync(join(home, "corpus", "bronze", "github"), { recursive: true });
  mkdirSync(join(home, "corpus", "bronze", "slack"), { recursive: true });
  writeFileSync(bronzeFile({ home, source: "github", window }), JSON.stringify(BRONZE[0]), "utf8");
  writeFileSync(bronzeFile({ home, source: "slack", window }), JSON.stringify(BRONZE[1]), "utf8");
  if (roster !== undefined) {
    writeFileSync(stateHomePaths({ home }).identityJson, roster, "utf8");
  }
  return home;
}

const ROSTER = JSON.stringify([
  {
    handle: "ada",
    id: "person:ada",
    identities: [
      { nativeId: "ada", source: "github" },
      { nativeId: "U1", source: "slack" },
    ],
    name: "Ada Lovelace",
  },
]);

describe("runDeriveWithDeps — identity resolution", () => {
  it("reads the off-repo roster and writes the merged person to silver/index/identities.json", () => {
    const home = seedHome({ roster: ROSTER });
    const code = runDeriveWithDeps({ argv: ["x", "y", "derive", "--home", home], sink: () => {} });
    expect(code).toBe(EXIT_OK);
    const written = JSON.parse(readFileSync(silverIdentitiesPath({ home }), "utf8")) as {
      people: { id: string; confidence: string; identities: { source: string }[] }[];
    };
    expect(written.people).toHaveLength(1);
    expect(written.people[0]!.id).toBe("person:ada");
    expect(written.people[0]!.confidence).toBe("override");
    expect(written.people[0]!.identities.map((i) => i.source).toSorted()).toEqual(["github", "slack"]);
  });

  it("emits non-blocking progress lines for the resolution pass through the injected sink", () => {
    const home = seedHome({ roster: ROSTER });
    const lines: string[] = [];
    runDeriveWithDeps({ argv: ["x", "y", "derive", "--home", home], sink: (line) => lines.push(line) });
    const parsed = lines.map((l) => JSON.parse(l) as { type: string; phase: string; verb: string });
    expect(parsed.every((p) => p.type === "slopweaver.progress" && p.verb === "derive")).toBe(true);
    expect(parsed.some((p) => p.phase === "resolve-identities")).toBe(true);
  });

  it("skips a malformed roster entry without aborting the derive", () => {
    const roster = JSON.stringify([
      { id: "person:ada", identities: [{ nativeId: "ada", source: "github" }] },
      { notAnId: true }, // malformed → skipped
    ]);
    const home = seedHome({ roster });
    const code = runDeriveWithDeps({ argv: ["x", "y", "derive", "--home", home], sink: () => {} });
    expect(code).toBe(EXIT_OK);
    expect(existsSync(silverIdentitiesPath({ home }))).toBe(true);
  });

  it("writes nothing on --dry-run", () => {
    const home = seedHome({ roster: ROSTER });
    const code = runDeriveWithDeps({ argv: ["x", "y", "derive", "--home", home, "--dry-run"], sink: () => {} });
    expect(code).toBe(EXIT_OK);
    expect(existsSync(silverIdentitiesPath({ home }))).toBe(false);
  });
});
