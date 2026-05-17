/**
 * Pure logic for `check-error-code-preservation`.
 *
 * Blocks `.mapErr()` calls that create objects with `message` but drop
 * `code`. When the error `code` discriminant is stripped at a port/adapter
 * boundary, downstream consumers can no longer branch on the typed error
 * union — auth failures get misclassified as generic 500s, retry logic
 * loses its signal, and the whole "single source of error truth" pattern
 * documented in `.claude/rules/error-handling.md` falls apart.
 *
 * Scope is the source trees in `packages/` and `apps/`, excluding test
 * files, cassette recordings, build output, and the neverthrow barrel
 * itself (which legitimately re-shapes errors).
 *
 * Ported verbatim from slopweaver-archive's check-error-code-preservation.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const IGNORE_DIRS = new Set(['__recordings__', '__tests__', '.turbo', 'dist', 'node_modules']);

const SCAN_ROOTS: ReadonlyArray<string> = ['packages', 'apps'];

/**
 * Check whether a `.mapErr(...)` callback body has `message:` but not `code:`.
 *
 * @param objectBody - The object literal body text inside the mapErr callback
 * @returns true if the body has message without code (a violation)
 */
export function isCodeDropped({ objectBody }: { objectBody: string }): boolean {
  const hasMessage = /\bmessage\s*:/.test(objectBody);
  const hasCode = /\bcode\s*:/.test(objectBody);
  return hasMessage && !hasCode;
}

/**
 * Scan a file's lines for `.mapErr()` calls that drop the `code` field.
 *
 * @param relPath - Relative file path from monorepo root (for reporting)
 * @param lines - Array of file lines
 * @returns Array of violations found
 */
export function scanFileLines({
  relPath,
  lines,
}: {
  relPath: string;
  lines: ReadonlyArray<string>;
}): Violation[] {
  const violations: Violation[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!line.includes('.mapErr(')) continue;
    // Skip when the trigger sits in a comment-only line (this scanner's own
    // doc comments contain example patterns; without this guard we'd flag
    // ourselves on every run).
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;

    const windowSize = 10;
    const window = lines.slice(i, i + windowSize).join('\n');

    // Inline-return arrow: `.mapErr((e) => ({ message: e.message }))`
    // Bounded input: the scan window is at most 10 lines of source TS — ReDoS is not practical.
    // eslint-disable-next-line regexp/no-super-linear-backtracking
    const inlineMatch = window.match(/\.mapErr\s*\(\s*\(?[^)]*\)?\s*=>\s*\(\s*\{([^}]*)\}\s*\)/s);
    if (inlineMatch) {
      const objectBody = inlineMatch[1] ?? '';
      if (isCodeDropped({ objectBody })) {
        violations.push({ file: relPath, line: i + 1, text: line.trim() });
      }
      continue;
    }

    // Block-body arrow: `.mapErr((e) => { return { message: e.message }; })`
    // Bounded input: the scan window is at most 10 lines of source TS — ReDoS is not practical.
    const returnMatch = window.match(
      /\.mapErr\s*\(\s*\(?[^)]*\)?\s*=>\s*\{\s*return\s*\{\s*([^}]*)\}\s*;?\s*\}/s, // eslint-disable-line regexp/no-super-linear-backtracking
    );
    if (returnMatch) {
      const objectBody = returnMatch[1] ?? '';
      if (isCodeDropped({ objectBody })) {
        violations.push({ file: relPath, line: i + 1, text: line.trim() });
      }
    }
  }

  return violations;
}

/**
 * List `.ts` files under the configured scan roots, skipping ignored
 * directories. Returns workspace-relative paths.
 */
export function listScanFiles({ root }: { root: string }): string[] {
  const out: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    const abs = join(root, scanRoot);
    if (!existsSync(abs)) continue;
    walk({ abs, rel: scanRoot, out });
  }
  return out;
}

function walk({ abs, rel, out }: { abs: string; rel: string; out: string[] }): void {
  for (const entry of readdirSync(abs)) {
    if (IGNORE_DIRS.has(entry)) continue;
    // Skip sibling CLI scanners — they contain example violation patterns
    // in their own source / doc comments that would self-trigger.
    if (entry.startsWith('check-')) continue;
    const childAbs = join(abs, entry);
    const childRel = `${rel}/${entry}`;
    const stat = statSync(childAbs);
    if (stat.isDirectory()) {
      walk({ abs: childAbs, rel: childRel, out });
      continue;
    }
    if (!stat.isFile()) continue;
    // Exclude test files — they may intentionally drop fields to assert behavior.
    if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) continue;
    if (!entry.endsWith('.ts')) continue;
    out.push(childRel);
  }
}

/**
 * Read each file in `paths` and aggregate every `.mapErr` violation across
 * the corpus. Caller is responsible for producing `paths` (typically via
 * `listScanFiles`); this keeps the I/O surface separate from the pure
 * scanning logic in `scanFileLines`.
 *
 * @returns aggregated violations across all scanned files.
 */
export function scanFiles({
  root,
  paths,
}: {
  root: string;
  paths: ReadonlyArray<string>;
}): Violation[] {
  const out: Violation[] = [];
  for (const file of paths) {
    const content = readFileSync(join(root, file), 'utf8');
    const lines = content.split('\n');
    out.push(...scanFileLines({ relPath: file, lines }));
  }
  return out;
}
