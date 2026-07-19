/**
 * The resilience-residue gate — a ratchet that fails the build if any hand-rolled retry / backoff /
 * rate-limiter is REINTRODUCED after the PR3.5 librafication (D21). Resilience must come from the
 * maintained libraries behind `src/lib/resilience.ts` (p-retry, p-limit, p-throttle) or, for GitHub,
 * octokit's own retry/throttle plugins — never from a bespoke loop.
 *
 * Mirrors the hygiene gate's shape: a PURE {@link scanResilienceContent} (unit-tested with inline
 * fixtures, so this file never scans itself) + an effectful {@link runResilienceResidue} edge that walks
 * the tracked TypeScript sources. The scanner's OWN files are excluded — they necessarily name the very
 * patterns they forbid (the same reason the hygiene denylist lives outside its scanner).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One residue hit: where it is + which forbidden pattern it matched. */
export interface ResidueHit {
  readonly path: string;
  readonly line: number;
  readonly label: string;
  readonly excerpt: string;
}

interface ResiduePattern {
  readonly label: string;
  readonly re: RegExp;
}

/**
 * The forbidden shapes. Each names a bespoke-resilience reintroduction; the library seams (`p-retry`,
 * `p-limit`, `p-throttle`, `retryTransient`, `createRateScheduler`) and octokit's `@octokit/plugin-retry`
 * do NOT match any of these, so they stay allowed.
 */
const PATTERNS: readonly ResiduePattern[] = [
  // The deleted hand-rolled rate limiter, by its old class name.
  { label: "hand-rolled-rate-limiter", re: /\bRateBucket\b/ },
  // An import of either deleted module (`lib/retry` / `lib/rateBucket`).
  { label: "deleted-resilience-module", re: /lib\/(?:retry|rateBucket)(?:\.js)?/ },
  // A bespoke `retry` function declaration (octokit's is a named IMPORT — `import { retry }` — not a decl).
  { label: "bespoke-retry-decl", re: /\b(?:async\s+)?function retry\b|\bconst retry\s*=/ },
  // Token-bucket wording — the signature of a hand-rolled pacing primitive.
  { label: "token-bucket", re: /token[ -]bucket/i },
];

/**
 * Pure: every forbidden-pattern hit in one file's content, with line numbers. Never throws — a test
 * feeds it inline fixtures so the gate stays falsifiable without touching the filesystem.
 *
 * @param path the file's repo-relative path (for reporting)
 * @param content the file's text
 * @returns each residue hit (empty when clean)
 */
export function scanResilienceContent({ path, content }: { path: string; content: string }): readonly ResidueHit[] {
  const hits: ResidueHit[] = [];
  content.split("\n").forEach((line, index) => {
    for (const { label, re } of PATTERNS) {
      const match = re.exec(line);
      if (match !== null) {
        hits.push({ excerpt: match[0], label, line: index + 1, path });
      }
    }
  });
  return hits;
}

/** The scanner's own files — excluded from the walk, since they necessarily contain the forbidden words. */
const SELF_FILES: ReadonlySet<string> = new Set([
  "resilienceResidue.ts",
  "resilienceResidue.entry.ts",
  "resilienceResidue.test.ts",
]);

/** Whether a repo-relative path is an in-scope TypeScript source (a `.ts` under `src/`, not a self file). */
export function isScannablePath({ path }: { path: string }): boolean {
  return path.startsWith("src/") && path.endsWith(".ts") && !SELF_FILES.has(basename(path));
}

/** Repo root, anchored on THIS module's own location (not cwd), so the gate scans the repo it belongs to. */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** List git-tracked files (repo-relative), anchored at `root`. Throws if run outside a git checkout. */
function trackedFiles({ root }: { root: string }): readonly string[] {
  return execFileSync("git", ["-C", root, "ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * IO edge: scan every in-scope tracked source, print each hit, return 0 (clean) or 1 (any hit / hard error).
 *
 * @returns the process exit code (0 clean, 1 residue found or not a git checkout)
 */
export function runResilienceResidue(): number {
  let root: string;
  let files: readonly string[];
  try {
    root = repoRoot();
    files = trackedFiles({ root });
  } catch {
    process.stderr.write("resilience-residue: not a git checkout (git ls-files failed)\n");
    return 1;
  }
  const scanned = files.filter((path) => isScannablePath({ path }));
  const hits: ResidueHit[] = [];
  for (const path of scanned) {
    let content: string;
    try {
      content = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    hits.push(...scanResilienceContent({ content, path }));
  }
  if (hits.length === 0) {
    process.stdout.write(`resilience-residue: clean (${String(scanned.length)} sources scanned)\n`);
    return 0;
  }
  process.stderr.write(`resilience-residue: ${String(hits.length)} hand-rolled-resilience hit(s):\n`);
  for (const hit of hits) {
    process.stderr.write(`  ${hit.path}:${String(hit.line)}: [${hit.label}] ${hit.excerpt}\n`);
  }
  process.stderr.write("resilience must use src/lib/resilience.ts (p-retry/p-limit/p-throttle) or octokit plugins.\n");
  return 1;
}
