/**
 * The boundary-residue gate — the PR3.6 ratchet that keeps every EXTERNAL network/model call behind a
 * `safe*` wrapper (so a throw becomes a typed {@link ../lib/ingestError.IngestError}, never a lossy
 * boolean or a swallowed try/catch). It re-skins the archive's `check:neverthrow-service-boundaries`:
 * one rule — a boundary token (an SDK client call, a GraphQL `rawRequest`, the `claude` `.complete`, an
 * embedder `.embed*`) is a violation UNLESS it sits inside the parentheses of a `safe*` call.
 *
 * Scope (deliberate): the SDK / HTTP / LLM / embed boundaries — the calls whose thrown errors the old
 * `isTransientError` boolean flattened. Filesystem writes are routed through `safeFs` where the tiering
 * path benefits (jsonFile / vectorCacheStore / distil), but are NOT policed repo-wide, to avoid churning
 * the many pre-existing atomic-write edges (watermarks, ledgers, corpus writer) this refactor doesn't touch.
 *
 * Pure {@link scanBoundaryContent} (unit-tested with inline fixtures — string/comment noise is stripped so
 * a token NAMED in prose never trips it) + an effectful {@link runBoundaryResidue} edge that walks the
 * tracked sources. The scanner's own files + `*.test.ts` + the dev-lint fixtures are excluded.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** One boundary hit: where it is + which external call was left unwrapped. */
export interface BoundaryHit {
  readonly path: string;
  readonly line: number;
  readonly label: string;
  readonly excerpt: string;
}

interface BoundaryToken {
  readonly label: string;
  readonly re: RegExp;
}

/**
 * The external-boundary call shapes. Each must sit inside a `safe*` wrapper. The `safe*` helpers
 * themselves call `execute()` (no token), so they never match; a token NAMED in a comment is stripped
 * before the scan, so prose ("the raw `client.*` boundary") never trips it.
 */
const BOUNDARY_TOKENS: readonly BoundaryToken[] = [
  // The Slack/Notion SDK client surfaces used in the connectors.
  { label: "sdk-client-call", re: /\bclient\.(?:conversations|users|auth|blocks|comments|dataSources|search)\b/ },
  // The Linear GraphQL transport.
  { label: "graphql-raw-request", re: /\.rawRequest\s*\(/ },
  // The `claude` LLM transport (an LlmClient.complete call — not `completeStructured(`).
  { label: "llm-complete", re: /\.complete\s*\(/ },
  // The on-device embedder.
  { label: "embed-call", re: /\.embed(?:Documents|Query)\s*\(/ },
];

/** The `safe*` wrapper openers whose parentheses sanction a boundary token. */
const SAFE_OPENER = /\bsafe(?:ApiCall|Llm|Embed|FsAsync|Fs)$/;

/**
 * Blank the contents of string literals + comments (preserving length + newlines), so paren-matching and
 * token detection see only CODE. Prevents a boundary token named in a comment/string from being scanned.
 *
 * @param content the raw source
 * @returns the source with string/comment interiors replaced by spaces
 */
export function stripNoise({ content }: { content: string }): string {
  const out: string[] = [];
  let state: "code" | "line" | "block" | "single" | "double" | "template" = "code";
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i]!;
    const next = content[i + 1];
    const blank = c === "\n" ? "\n" : " ";
    if (state === "code") {
      if (c === "/" && next === "/") {
        state = "line";
        out.push(" ");
      } else if (c === "/" && next === "*") {
        state = "block";
        out.push(" ");
      } else if (c === "'") {
        state = "single";
        out.push(" ");
      } else if (c === '"') {
        state = "double";
        out.push(" ");
      } else if (c === "`") {
        state = "template";
        out.push(" ");
      } else {
        out.push(c);
      }
      continue;
    }
    if (state === "line") {
      out.push(blank);
      if (c === "\n") {
        state = "code";
      }
      continue;
    }
    if (state === "block") {
      out.push(blank);
      if (c === "*" && next === "/") {
        out.push(" ");
        i += 1;
        state = "code";
      }
      continue;
    }
    // string / template body: blank until the (unescaped) closing quote
    out.push(blank);
    if (c === "\\") {
      out.push(content[i + 1] === "\n" ? "\n" : " ");
      i += 1;
      continue;
    }
    if ((state === "single" && c === "'") || (state === "double" && c === '"') || (state === "template" && c === "`")) {
      state = "code";
    }
  }
  return out.join("");
}

/** The `[start, end)` index ranges that lie inside a `safe*` wrapper's parentheses (noise-stripped code). */
function safeRanges({ code }: { code: string }): readonly (readonly [number, number])[] {
  const ranges: (readonly [number, number])[] = [];
  const open: { atDepth: number; start: number }[] = [];
  let depth = 0;
  for (let i = 0; i < code.length; i += 1) {
    const c = code[i]!;
    if (c === "(") {
      depth += 1;
      if (SAFE_OPENER.test(code.slice(Math.max(0, i - 24), i))) {
        open.push({ atDepth: depth, start: i + 1 });
      }
    } else if (c === ")") {
      const top = open[open.length - 1];
      if (top?.atDepth === depth) {
        open.pop();
        ranges.push([top.start, i]);
      }
      depth -= 1;
    }
  }
  return ranges;
}

/** Whether an index falls inside any sanctioned safe-wrapper range. */
function inSafeRange({ ranges, index }: { ranges: readonly (readonly [number, number])[]; index: number }): boolean {
  return ranges.some(([start, end]) => index >= start && index < end);
}

/**
 * Pure: every unwrapped boundary token in one file's content. A token inside a `safe*` wrapper's parens is
 * allowed; anywhere else (a bare `await`, a raw try/catch) is a hit. Never throws.
 *
 * @param path the file's repo-relative path (for reporting)
 * @param content the file's text
 * @returns each unwrapped-boundary hit (empty when clean)
 */
export function scanBoundaryContent({ path, content }: { path: string; content: string }): readonly BoundaryHit[] {
  const code = stripNoise({ content });
  const ranges = safeRanges({ code });
  const hits: BoundaryHit[] = [];
  for (const { label, re } of BOUNDARY_TOKENS) {
    const rx = new RegExp(re.source, "g");
    let match = rx.exec(code);
    while (match !== null) {
      if (!inSafeRange({ index: match.index, ranges })) {
        hits.push({ excerpt: match[0], label, line: code.slice(0, match.index).split("\n").length, path });
      }
      match = rx.exec(code);
    }
  }
  return hits.toSorted((a, b) => a.line - b.line);
}

/** The scanner's own files — excluded from the walk (they necessarily contain the forbidden words). */
const SELF_FILES: ReadonlySet<string> = new Set([
  "boundaryResidue.ts",
  "boundaryResidue.entry.ts",
  "boundaryResidue.test.ts",
]);

/** Whether a repo-relative path is an in-scope source: a non-test `.ts` under `src/`, not a self file. */
export function isScannablePath({ path }: { path: string }): boolean {
  return (
    path.startsWith("src/") && path.endsWith(".ts") && !path.endsWith(".test.ts") && !SELF_FILES.has(basename(path))
  );
}

/** Repo root, anchored on THIS module's own location (not cwd), so the gate scans the repo it belongs to. */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** List git-tracked `src` files (repo-relative), anchored at `root`. Throws if run outside a git checkout. */
function trackedFiles({ root }: { root: string }): readonly string[] {
  return execFileSync("git", ["-C", root, "ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * IO edge: scan every in-scope tracked source, print each hit, return 0 (clean) or 1 (any hit / hard error).
 *
 * @returns the process exit code (0 clean, 1 unwrapped boundary found or not a git checkout)
 */
export function runBoundaryResidue(): number {
  let root: string;
  let files: readonly string[];
  try {
    root = repoRoot();
    files = trackedFiles({ root });
  } catch {
    process.stderr.write("boundary-residue: not a git checkout (git ls-files failed)\n");
    return 1;
  }
  const scanned = files.filter((path) => isScannablePath({ path }));
  const hits: BoundaryHit[] = [];
  for (const path of scanned) {
    let content: string;
    try {
      content = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    hits.push(...scanBoundaryContent({ content, path }));
  }
  if (hits.length === 0) {
    process.stdout.write(`boundary-residue: clean (${String(scanned.length)} sources scanned)\n`);
    return 0;
  }
  process.stderr.write(`boundary-residue: ${String(hits.length)} unwrapped-boundary hit(s):\n`);
  for (const hit of hits) {
    process.stderr.write(`  ${hit.path}:${String(hit.line)}: [${hit.label}] ${hit.excerpt}\n`);
  }
  process.stderr.write("every external boundary must go through a safe* wrapper (src/lib/safeBoundary.ts).\n");
  return 1;
}
