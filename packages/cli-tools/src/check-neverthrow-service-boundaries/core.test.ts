import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findThrowSites, isCommentOnlyLine, listBoundaryFiles, scanFiles } from './core.ts';

describe('isCommentOnlyLine', () => {
  it('flags // line comments', () => {
    expect(isCommentOnlyLine({ line: '// throw new Error("nope")' })).toBe(true);
    expect(isCommentOnlyLine({ line: '  // throw new Error("nope")' })).toBe(true);
  });

  it('flags lines that are part of a block comment formatted by biome', () => {
    expect(isCommentOnlyLine({ line: ' * throw something' })).toBe(true);
    expect(isCommentOnlyLine({ line: '/** docblock' })).toBe(true);
  });

  it('does not flag normal code', () => {
    expect(isCommentOnlyLine({ line: 'throw new Error("real")' })).toBe(false);
    expect(isCommentOnlyLine({ line: '  throw new Error("indented")' })).toBe(false);
  });
});

describe('findThrowSites', () => {
  it('returns findings for top-level throws', () => {
    const content = [
      'export function f() {',
      '  if (bad) throw new Error("boom");',
      '  return 1;',
      '}',
    ].join('\n');

    const findings = findThrowSites({ content, file: 'a.ts' });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toEqual({
      file: 'a.ts',
      line: 2,
      text: '  if (bad) throw new Error("boom");',
    });
  });

  it('returns findings for re-throws inside catch blocks', () => {
    const content = ['try {', '  doIt();', '} catch (e) {', '  throw e;', '}'].join('\n');

    const findings = findThrowSites({ content, file: 'a.ts' });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(4);
  });

  it('ignores `throw` inside line comments', () => {
    const content = '// always throw on bad input\nreturn 1;';

    expect(findThrowSites({ content, file: 'a.ts' })).toEqual([]);
  });

  it('ignores identifiers that contain "throw" as a substring', () => {
    const content = 'const mythrow = 1;\nthrowsHelper();';

    expect(findThrowSites({ content, file: 'a.ts' })).toEqual([]);
  });

  it('does not fire on a `} catch {` line', () => {
    const content = '} catch (err) {\n  log(err);\n}';

    expect(findThrowSites({ content, file: 'a.ts' })).toEqual([]);
  });
});

describe('listBoundaryFiles + scanFiles', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'check-svc-bound-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('walks the configured directory and reports throws while skipping test files', () => {
    const dir = 'packages/integrations/slack/src';
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(
      join(root, dir, 'has-throw.ts'),
      'export function go() {\n  throw new Error("nope");\n}\n',
    );
    writeFileSync(
      join(root, dir, 'has-throw.test.ts'),
      'import { go } from "./has-throw.ts";\nexpect(() => go()).toThrow();\n',
    );

    const paths = listBoundaryFiles({
      root,
      boundaries: [{ dir, extensions: ['.ts'] }],
      files: [],
    });
    expect(paths).toEqual(['packages/integrations/slack/src/has-throw.ts']);

    const findings = scanFiles({ root, paths });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });

  it('includes explicit per-file boundaries', () => {
    const dir = 'packages/cli-tools/src/orchestration';
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, 'core.ts'), 'export function ok() { return 1; }\n');

    const paths = listBoundaryFiles({
      root,
      boundaries: [],
      files: ['packages/cli-tools/src/orchestration/core.ts'],
    });

    expect(paths).toEqual(['packages/cli-tools/src/orchestration/core.ts']);
  });
});
