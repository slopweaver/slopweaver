/**
 * Pure functions for the neverthrow service-boundary check.
 *
 * The rule (per `.claude/rules/error-handling.md` and #41): files inside
 * the configured "service boundaries" must not throw. Service code
 * returns `Result<T, E>` / `ResultAsync<T, E>` instead. Recovery catches
 * (e.g. swallowing per-platform poll failures so the overall session
 * proceeds) are legitimate and stay — those don't show up as `throw`
 * statements, so the same scanner that flags throws ignores them.
 *
 * Boundaries are an explicit list rather than a sweeping glob so we can
 * point at the smallest set of files that actually constitute the
 * service surface. Test files, recording fixtures, and src/test/
 * helpers are excluded — they're scaffolding, not service code.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

interface ServiceBoundaryDir {
  readonly dir: string;
  readonly extensions: ReadonlyArray<string>;
}

export interface ThrowFinding {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const SERVICE_BOUNDARY_DIRS: ReadonlyArray<ServiceBoundaryDir> = [
  { dir: 'packages/integrations/core/src', extensions: ['.ts'] },
  { dir: 'packages/integrations/github/src', extensions: ['.ts'] },
  { dir: 'packages/integrations/slack/src', extensions: ['.ts'] },
  { dir: 'packages/mcp-server/src/tools', extensions: ['.ts'] },
  { dir: 'apps/mcp-local/src/connect', extensions: ['.ts'] },
];

const SERVICE_BOUNDARY_FILES: ReadonlyArray<string> = [
  'packages/cli-tools/src/orchestration/core.ts',
  'packages/cli-tools/src/orchestration/runtime.ts',
];

const EXCLUDED_DIR_NAMES = new Set([
  'test',
  'tests',
  'test-setup',
  '__tests__',
  '__recordings__',
  'node_modules',
  'dist',
]);
const EXCLUDED_FILE_SUFFIXES = ['.test.ts', '.smoke.test.ts', '.cassette.test.ts'];

/**
 * Recursively list `.ts` files under `root/<boundary.dir>`, skipping test
 * files and helper subdirectories. Returns workspace-relative paths so
 * findings print stably regardless of the caller's cwd.
 */
export function listBoundaryFiles({
  root,
  boundaries = SERVICE_BOUNDARY_DIRS,
  files = SERVICE_BOUNDARY_FILES,
}: {
  root: string;
  boundaries?: ReadonlyArray<ServiceBoundaryDir>;
  files?: ReadonlyArray<string>;
}): string[] {
  const out: string[] = [];

  for (const boundary of boundaries) {
    const abs = join(root, boundary.dir);
    if (!existsSync(abs)) continue;
    walk({ abs, rel: boundary.dir, extensions: boundary.extensions, out });
  }

  for (const file of files) {
    const abs = join(root, file);
    if (existsSync(abs)) out.push(file);
  }

  return out;
}

function walk({
  abs,
  rel,
  extensions,
  out,
}: {
  abs: string;
  rel: string;
  extensions: ReadonlyArray<string>;
  out: string[];
}): void {
  for (const entry of readdirSync(abs)) {
    if (EXCLUDED_DIR_NAMES.has(entry)) continue;
    const childAbs = join(abs, entry);
    const childRel = `${rel}/${entry}`;
    const stat = statSync(childAbs);
    if (stat.isDirectory()) {
      walk({ abs: childAbs, rel: childRel, extensions, out });
      continue;
    }
    if (!stat.isFile()) continue;
    if (EXCLUDED_FILE_SUFFIXES.some((suffix) => entry.endsWith(suffix))) continue;
    if (!extensions.some((ext) => entry.endsWith(ext))) continue;
    out.push(childRel);
  }
}

/**
 * `// foo` and lines that are part of a `/* … *\/` block (which biome
 * formats with `*` at line start). The scanner runs against source code
 * formatted by biome, so the simple form is good enough — we don't need
 * to track block-comment state across lines.
 */
export function isCommentOnlyLine({ line }: { line: string }): boolean {
  return /^\s*(\/\/|\*|\/\*)/.test(line);
}

/**
 * Match `throw` as a keyword: at start of line (with whitespace), after
 * an opening brace, after a semicolon, or after `else `. The keyword
 * itself must be followed by whitespace so we don't fire on identifiers
 * like `mythrow`.
 */
const THROW_KEYWORD_PATTERN = /(?:^|[\s;{])throw\s/;

/**
 * Find lines in `content` that contain a `throw` keyword and aren't
 * comment-only.
 */
export function findThrowSites({
  content,
  file,
}: {
  content: string;
  file: string;
}): ThrowFinding[] {
  const findings: ThrowFinding[] = [];
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const text = lines[i];
    if (text === undefined) continue;
    if (isCommentOnlyLine({ line: text })) continue;
    if (!THROW_KEYWORD_PATTERN.test(text)) continue;
    findings.push({ file, line: i + 1, text: text.trimEnd() });
  }
  return findings;
}

export function scanFiles({
  root,
  paths,
}: {
  root: string;
  paths: ReadonlyArray<string>;
}): ThrowFinding[] {
  const out: ThrowFinding[] = [];
  for (const file of paths) {
    const content = readFileSync(join(root, file), 'utf8');
    out.push(...findThrowSites({ content, file }));
  }
  return out;
}
