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
 * files, cassette recordings, build output, and sibling scanner sources.
 *
 * Implementation: TypeScript AST walk via the compiler API. A previous
 * regex-based implementation tripped `regexp/no-super-linear-backtracking`
 * and self-flagged on its own doc comments; the AST walk has neither
 * problem because it sees the parsed program, not raw text.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

export interface Violation {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const IGNORE_DIRS = new Set(['__recordings__', '__tests__', '.turbo', 'dist', 'node_modules']);
const SCAN_ROOTS: ReadonlyArray<string> = ['packages', 'apps'];

/**
 * Given the object literal returned by a `.mapErr(...)` callback, decide if
 * it drops the `code` field while still defining `message`. The discriminant
 * (`code`) must be threaded through every transformation; an inline object
 * literal that lists `message` but not `code` is the canonical violation.
 *
 * Spread elements (`...e`) count as "code is present" because they forward
 * every field from the source error.
 */
export function objectDropsCode({ node }: { node: ts.ObjectLiteralExpression }): boolean {
  let hasMessage = false;
  let hasCode = false;
  for (const prop of node.properties) {
    if (ts.isSpreadAssignment(prop)) {
      // `...e` — forwards everything including code.
      hasCode = true;
      continue;
    }
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) continue;
    const name = prop.name;
    if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) continue;
    if (name.text === 'message') hasMessage = true;
    if (name.text === 'code') hasCode = true;
  }
  return hasMessage && !hasCode;
}

/**
 * Walk a parsed source file and return every `.mapErr(callback)` whose
 * callback returns an object literal that drops the `code` field. Two callback
 * shapes are inspected:
 *   - inline-return arrow: `.mapErr((e) => ({ message: e.message }))`
 *   - block-body arrow / function with `return { ... }`
 * Other shapes (factory call, chained call, ternary, etc.) are skipped — if
 * the callback isn't a literal object construction at the boundary, there's
 * nothing for this scanner to flag.
 */
export function scanSource({ relPath, source }: { relPath: string; source: string }): Violation[] {
  const violations: Violation[] = [];
  const sourceFile = ts.createSourceFile(relPath, source, ts.ScriptTarget.Latest, true);

  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'mapErr'
    ) {
      const arg = node.arguments[0];
      if (arg && (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg))) {
        const objectLiteral = extractReturnedObjectLiteral({ callback: arg });
        if (objectLiteral && objectDropsCode({ node: objectLiteral })) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          violations.push({
            file: relPath,
            line: line + 1,
            text: source.split('\n')[line]?.trim() ?? '',
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return violations;
}

function extractReturnedObjectLiteral({
  callback,
}: {
  callback: ts.ArrowFunction | ts.FunctionExpression;
}): ts.ObjectLiteralExpression | null {
  const body = callback.body;
  // Arrow with expression body: `(e) => ({ ... })` — body is the parenthesized object.
  if (ts.isParenthesizedExpression(body) && ts.isObjectLiteralExpression(body.expression)) {
    return body.expression;
  }
  // Arrow with object body directly (rare; tsc usually wraps in parens but be safe):
  if (ts.isObjectLiteralExpression(body)) return body;
  // Block body: look for a single top-level `return { ... };`
  if (ts.isBlock(body)) {
    for (const stmt of body.statements) {
      if (ts.isReturnStatement(stmt) && stmt.expression && ts.isObjectLiteralExpression(stmt.expression)) {
        return stmt.expression;
      }
    }
  }
  return null;
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
    // Skip sibling CLI scanners — they may contain example violation patterns
    // in source / doc comments. AST-based scanning won't trip on comments,
    // but the sibling scanners themselves shouldn't be in the audit scope.
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
 * scanning logic in `scanSource`.
 *
 * @returns aggregated violations across all scanned files.
 */
export function scanFiles({ root, paths }: { root: string; paths: ReadonlyArray<string> }): Violation[] {
  const out: Violation[] = [];
  for (const file of paths) {
    const source = readFileSync(join(root, file), 'utf8');
    out.push(...scanSource({ relPath: file, source }));
  }
  return out;
}
