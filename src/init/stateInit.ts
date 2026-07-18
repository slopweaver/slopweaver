/**
 * Idempotent scaffolding of `$SLOPWEAVER_HOME`. Creates every directory the agent persists into and
 * seeds the small marker/seed files (home-version, identity, profile, denylist) from templates — but
 * NEVER overwrites a file that already exists, so a hand-edited profile or a populated corpus survives a
 * re-run untouched. Running it twice is a no-op that reports everything as already-present.
 *
 * All paths come from the one home-path contract ({@link stateHomePaths}); this module never derives a
 * home sub-path itself. It is the effectful edge — the only writer — kept thin over that pure contract.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { STATE_HOME_VERSION, stateHomePaths } from "../stateHome.js";

/** What a run of {@link runInit} did to one path: made it, or found it already there. */
export type InitOutcome = "created" | "existed";

/** One path's init result, for the report doctor + the CLI print. */
export interface InitEntry {
  readonly path: string;
  readonly kind: "dir" | "file";
  readonly outcome: InitOutcome;
}

/** The full report of an init run — every dir + seed file, in a stable order. */
export interface InitReport {
  readonly home: string;
  readonly entries: readonly InitEntry[];
}

/** Read a bundled template file (relative to this module), for seeding identity/profile. */
function readTemplate({ name }: { name: string }): string {
  return readFileSync(fileURLToPath(new URL(`../../templates/${name}`, import.meta.url)), "utf8");
}

/** The comment-only seed for the private denylist — explains the file without listing any term. */
const DENYLIST_SEED = [
  "# Private hygiene denylist — one case-insensitive substring per line.",
  "# This file is LOCAL to $SLOPWEAVER_HOME and is never committed. The public hygiene gate reads it",
  "# at runtime so the scanner never has to contain the very words it guards against. Add your",
  "# org-/project-specific literals below (blank lines and `#` comments are ignored).",
  "",
].join("\n");

/** mkdir -p, recording whether it already existed. */
function ensureDir({ path }: { path: string }): InitEntry {
  const existed = existsSync(path);
  mkdirSync(path, { recursive: true });
  return { kind: "dir", outcome: existed ? "existed" : "created", path };
}

/** Write `content` only when `path` is absent (never overwrite), recording the outcome. */
function seedFile({ path, content }: { path: string; content: string }): InitEntry {
  if (existsSync(path)) {
    return { kind: "file", outcome: "existed", path };
  }
  writeFileSync(path, content, "utf8");
  return { kind: "file", outcome: "created", path };
}

/**
 * Scaffold (or verify) the full state-home layout under `home`. Idempotent: dirs are `mkdir -p`; seed
 * files are written only when absent. Safe to run on every SessionStart.
 *
 * @param home the world-model home (defaults to the resolved {@link stateHomePaths} home)
 * @returns the per-path report (created vs already-present)
 */
export function runInit({ home }: { home?: string } = {}): InitReport {
  const paths = stateHomePaths(home !== undefined ? { home } : {});
  const entries: InitEntry[] = [
    ensureDir({ path: paths.root }),
    ensureDir({ path: paths.corpus.root }),
    ensureDir({ path: paths.corpus.bronze }),
    ensureDir({ path: paths.corpus.silver }),
    ensureDir({ path: paths.corpus.gold }),
    ensureDir({ path: paths.corpus.cache }),
    ensureDir({ path: paths.beliefs }),
    ensureDir({ path: paths.ledgers }),
    ensureDir({ path: paths.modelCache }),
    seedFile({ content: `${JSON.stringify({ version: STATE_HOME_VERSION }, null, 2)}\n`, path: paths.homeVersion }),
    seedFile({ content: readTemplate({ name: "identity.template.json" }), path: paths.identityJson }),
    seedFile({ content: readTemplate({ name: "profile.template.json" }), path: paths.profileJson }),
    seedFile({ content: DENYLIST_SEED, path: paths.hygieneDenylist }),
  ];
  return { entries, home: paths.root };
}
