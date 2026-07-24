import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { bronzeFile, silverIdentitiesPath, silverPeoplePath } from "../../../corpus/corpusPaths.js";
import { writeMemberRows } from "../../../corpus/members/store.js";
import type { MemberBronzeRow } from "../../../corpus/members/types.js";
import type { CorpusRecord } from "../../../corpus/types.js";
import { unwrap } from "../../../lib/result.js";
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

  it("streams the ordered derive stages (unthrottled) through the injected sink", () => {
    const home = seedHome({ roster: ROSTER });
    const lines: string[] = [];
    runDeriveWithDeps({ argv: ["x", "y", "derive", "--home", home], sink: (line) => lines.push(line) });
    const phases = lines.map((l) => (JSON.parse(l) as { phase: string }).phase);
    // Each stage is a distinct watchable step — the crawl-free synthesis lane runs unthrottled.
    expect(phases).toContain("read-corpus");
    expect(phases).toContain("build-directory");
    expect(phases).toContain("build-graphs");
    expect(phases).toContain("write-silver");
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

/** A trusted member row for a source/id (a real personal email — the resolver's join key). */
function memberRow({
  source,
  nativeId,
  email,
}: {
  source: MemberBronzeRow["source"];
  nativeId: string;
  email: string;
}): MemberBronzeRow {
  return {
    fetchedAtIso: "2026-07-20T00:00:00.000Z",
    identity: { email, emailNormalised: email.toLowerCase(), emailTrust: "trusted", name: nativeId, nativeId, source },
    profile: { active: true, bot: false },
    provenance: [`${source}.users`],
    raw: { id: nativeId },
    source,
    sourceId: nativeId,
    version: 1,
    warnings: [],
  };
}

describe("runDeriveWithDeps — member hydration feed (PR4.1)", () => {
  it("reads member bronze, auto-links the team by email with NO roster, and writes people.json", () => {
    const home = seedHome({});
    unwrap(
      writeMemberRows({
        home,
        rows: [memberRow({ email: "ada@example.com", nativeId: "U1", source: "slack" })],
        source: "slack",
      }),
    );
    unwrap(
      writeMemberRows({
        home,
        rows: [memberRow({ email: "ada@example.com", nativeId: "ada", source: "github" })],
        source: "github",
      }),
    );

    const code = runDeriveWithDeps({ argv: ["x", "y", "derive", "--home", home], sink: () => {} });
    expect(code).toBe(EXIT_OK);

    const people = (
      JSON.parse(readFileSync(silverPeoplePath({ home }), "utf8")) as {
        people: { confidence: string; emails: { value: string }[]; identities: { source: string }[] }[];
      }
    ).people;
    expect(people).toHaveLength(1);
    expect(people[0]!.confidence).toBe("email");
    expect(people[0]!.identities.map((i) => i.source).toSorted()).toEqual(["github", "slack"]);
    expect(people[0]!.emails).toEqual([{ sources: ["github", "slack"], trust: "trusted", value: "ada@example.com" }]);
  });
});
