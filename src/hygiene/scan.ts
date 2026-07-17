/**
 * Public hygiene gate — scans every git-tracked file for generic leak CLASSES (home paths, token shapes,
 * raw workspace-ID patterns) and exits non-zero listing every hit. It ships as a real feature: it protects
 * any user or fork from committing their own secrets. Runs in CI on every push and via `slopweaver hygiene`.
 *
 * It names no organisation. Org- or project-specific words you must never commit live in a PRIVATE,
 * uncommitted denylist at `$SLOPWEAVER_HOME/hygiene-denylist.txt` (one case-insensitive substring per line),
 * read at runtime — so the scanner never has to CONTAIN the very words it guards against.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { stateHomePaths } from "../stateHome.js";

export interface Hit {
  readonly path: string;
  readonly line: number;
  readonly label: string;
  readonly excerpt: string;
}

interface Pattern {
  readonly label: string;
  readonly re: RegExp;
}

/** The generic leak-class patterns. Token shapes require a real token suffix so a bare prefix never trips. */
const PATTERNS: readonly Pattern[] = [
  { label: "absolute-home-path", re: /\/(?:Users|home)\/[A-Za-z0-9._-]+/ },
  { label: "slack-token", re: /xox[bp]-[A-Za-z0-9-]{10,}/ },
  { label: "github-oauth-token", re: /gh[po]_[A-Za-z0-9]{20,}/ },
  { label: "github-pat", re: /github_pat_[A-Za-z0-9_]{20,}/ },
  { label: "notion-secret", re: /\bsecret_[A-Za-z0-9]{16,}/ },
  { label: "openai-style-key", re: /\bsk-[A-Za-z0-9]{20,}/ },
  // Raw Slack/Linear-style ID: a C/U/A/W prefix + 8+ upper-alnum. Require at least one digit (the
  // lookahead) so all-caps English words like WARRANTIES / COPYRIGHT are not mistaken for IDs.
  { label: "raw-workspace-id", re: /\b(?=[A-Z0-9]*[0-9])[CUAW][A-Z0-9]{8,}\b/ },
];

/**
 * Read the optional user denylist ($SLOPWEAVER_HOME/hygiene-denylist.txt); one case-insensitive
 * substring per line.
 *
 * @param home the SLOPWEAVER_HOME dir (undefined/empty ⇒ no denylist)
 * @returns the denylist substrings (blank + `#` lines dropped), or `[]`
 */
export function loadDenylist({ home }: { home: string | undefined }): readonly string[] {
  if (home === undefined || home.length === 0) {
    return [];
  }
  try {
    return readFileSync(stateHomePaths({ home }).hygieneDenylist, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

/** Pure: every leak-class + denylist hit in one file's content, with line numbers. Never throws. */
export function scanContent({
  path,
  content,
  denylist,
}: {
  path: string;
  content: string;
  denylist: readonly string[];
}): readonly Hit[] {
  const hits: Hit[] = [];
  const lines = content.split("\n");
  lines.forEach((line, index) => {
    for (const { label, re } of PATTERNS) {
      const match = re.exec(line);
      if (match !== null) {
        hits.push({ excerpt: match[0], label, line: index + 1, path });
      }
    }
    const lower = line.toLowerCase();
    for (const needle of denylist) {
      if (lower.includes(needle.toLowerCase())) {
        hits.push({ excerpt: needle, label: "denylist", line: index + 1, path });
      }
    }
  });
  return hits;
}

/**
 * Repo root, anchored on THIS module's own location (not cwd) — so the gate always scans the repo the
 * scanner belongs to, whether it's run from CI, the script, `slopweaver hygiene`, a subdir, or another repo.
 */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** List git-tracked files (repo-relative), anchored at `root`. Throws if run outside a git checkout. */
function trackedFiles({ root }: { root: string }): readonly string[] {
  return execFileSync("git", ["-C", root, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** A NUL byte is the cheap, reliable "this is binary, skip it" signal. */
function looksBinary({ content }: { content: string }): boolean {
  return content.includes("\u0000");
}

/** IO edge: scan every tracked file, print each hit, return 0 (clean) or 1 (any hit / hard error). */
export function runScan(): number {
  let root: string;
  let files: readonly string[];
  try {
    root = repoRoot();
    files = trackedFiles({ root });
  } catch {
    process.stderr.write("hygiene: not a git checkout (git ls-files failed)\n");
    return 1;
  }
  const denylist = loadDenylist({ home: process.env["SLOPWEAVER_HOME"] });
  const hits: Hit[] = [];
  for (const path of files) {
    let content: string;
    try {
      content = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    if (looksBinary({ content })) {
      continue;
    }
    hits.push(...scanContent({ content, denylist, path }));
  }
  if (hits.length === 0) {
    process.stdout.write(`hygiene: clean (${String(files.length)} files scanned)\n`);
    return 0;
  }
  process.stderr.write(`hygiene: ${String(hits.length)} leak-class hit(s):\n`);
  for (const hit of hits) {
    process.stderr.write(`  ${hit.path}:${String(hit.line)}: [${hit.label}] ${hit.excerpt}\n`);
  }
  return 1;
}
