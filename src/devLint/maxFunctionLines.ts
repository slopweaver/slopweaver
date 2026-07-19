/**
 * The max-function-lines gate — a per-FUNCTION size ratchet that keeps the "pure core / thin shell"
 * discipline from drifting back into 100+-line mixed-concern functions (the shape PR3.5's partial-output
 * bug hid in). It parses each source with the TypeScript compiler API (pure, in-memory — no filesystem)
 * and flags any function/method/arrow whose body spans more than {@link MAX_FUNCTION_LINES} lines.
 *
 * A genuinely-cohesive effectful shell that this refactor doesn't touch (e.g. a CLI verb's
 * parse→execute→report handler) can carry an inline `max-lines-exempt: <reason>` comment on the line
 * directly above it — the archive's inline-exemption pattern, so the bar stays honest instead of hiding
 * behind a hardcoded name list. `*.test.ts` and the scanner's own files are skipped.
 *
 * Pure {@link scanFunctionLines} (unit-tested with inline fixtures) + an effectful {@link runMaxFunctionLines}
 * edge that walks the tracked sources.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The per-function line ceiling (inclusive limit — a body of exactly this many lines passes). */
export const MAX_FUNCTION_LINES = 100;

/** The inline marker that exempts the function directly below it. */
export const EXEMPT_MARKER = "max-lines-exempt";

/** One oversized function: where it is, its name, and its body's line span. */
export interface OversizedFunction {
  readonly path: string;
  readonly name: string;
  readonly startLine: number;
  readonly lines: number;
}

/** The best display name for a function-like node (declaration name, assigned const, or `(anonymous)`). */
function nameOf({ node, sf }: { node: ts.Node; sf: ts.SourceFile }): string {
  if (ts.isFunctionDeclaration(node) && node.name !== undefined) {
    return node.name.getText(sf);
  }
  if (ts.isMethodDeclaration(node)) {
    return node.name.getText(sf);
  }
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) {
    return parent.name.getText(sf);
  }
  return "(anonymous)";
}

/**
 * Every function whose body exceeds `max` lines, unless the line above it carries the exempt marker. Pure —
 * parses `content` in memory with the TypeScript AST, so a test asserts exactly which functions trip it.
 *
 * @param path the file's repo-relative path (for reporting)
 * @param content the file's text
 * @param max the per-function line ceiling (defaults to {@link MAX_FUNCTION_LINES})
 * @returns each oversized function (empty when all are within the bar)
 */
export function scanFunctionLines({
  path,
  content,
  max = MAX_FUNCTION_LINES,
}: {
  path: string;
  content: string;
  max?: number;
}): readonly OversizedFunction[] {
  const sf = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const lines = content.split("\n");
  const results: OversizedFunction[] = [];
  const visit = (node: ts.Node): void => {
    const isFn =
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node);
    if (isFn && node.body !== undefined) {
      const startLine = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line;
      const endLine = sf.getLineAndCharacterOfPosition(node.getEnd()).line;
      const span = endLine - startLine + 1;
      const above = startLine > 0 ? lines[startLine - 1]! : "";
      if (span > max && !above.includes(EXEMPT_MARKER)) {
        results.push({ lines: span, name: nameOf({ node, sf }), path, startLine: startLine + 1 });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return results.toSorted((a, b) => b.lines - a.lines);
}

/** The scanner's own files — excluded from the walk. */
const SELF_FILES: ReadonlySet<string> = new Set([
  "maxFunctionLines.ts",
  "maxFunctionLines.entry.ts",
  "maxFunctionLines.test.ts",
]);

/** Whether a repo-relative path is an in-scope source: a non-test `.ts` under `src/`, not a self file. */
export function isScannablePath({ path }: { path: string }): boolean {
  return (
    path.startsWith("src/") && path.endsWith(".ts") && !path.endsWith(".test.ts") && !SELF_FILES.has(basename(path))
  );
}

/** Repo root, anchored on THIS module's own location (not cwd). */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return execFileSync("git", ["-C", here, "rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
}

/** List git-tracked `src` files (repo-relative), anchored at `root`. */
function trackedFiles({ root }: { root: string }): readonly string[] {
  return execFileSync("git", ["-C", root, "ls-files", "src"], { encoding: "utf8" })
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * IO edge: scan every in-scope tracked source, print each oversized function, return 0 (clean) or 1.
 *
 * @returns the process exit code (0 clean, 1 an oversized function found or not a git checkout)
 */
export function runMaxFunctionLines(): number {
  let root: string;
  let files: readonly string[];
  try {
    root = repoRoot();
    files = trackedFiles({ root });
  } catch {
    process.stderr.write("max-function-lines: not a git checkout (git ls-files failed)\n");
    return 1;
  }
  const scanned = files.filter((path) => isScannablePath({ path }));
  const hits: OversizedFunction[] = [];
  for (const path of scanned) {
    let content: string;
    try {
      content = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    hits.push(...scanFunctionLines({ content, path }));
  }
  if (hits.length === 0) {
    process.stdout.write(
      `max-function-lines: clean (${String(scanned.length)} sources scanned, limit ${String(MAX_FUNCTION_LINES)})\n`,
    );
    return 0;
  }
  process.stderr.write(
    `max-function-lines: ${String(hits.length)} function(s) over ${String(MAX_FUNCTION_LINES)} lines:\n`,
  );
  for (const hit of hits) {
    process.stderr.write(`  ${hit.path}:${String(hit.startLine)}: ${hit.name} (${String(hit.lines)} lines)\n`);
  }
  process.stderr.write(
    `decompose into pure cores + a thin shell, or add an inline "${EXEMPT_MARKER}: <reason>" comment.\n`,
  );
  return 1;
}
