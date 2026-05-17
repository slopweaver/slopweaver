import { describe, expect, it } from 'vitest';
import { objectDropsCode, scanSource } from './core.ts';
import ts from 'typescript';

function firstObjectLiteral(source: string): ts.ObjectLiteralExpression {
  const sourceFile = ts.createSourceFile('test.ts', source, ts.ScriptTarget.Latest, true);
  let found: ts.ObjectLiteralExpression | null = null;
  function visit(node: ts.Node): void {
    if (!found && ts.isObjectLiteralExpression(node)) found = node;
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  if (!found) throw new Error(`no object literal in: ${source}`);
  return found;
}

describe('objectDropsCode', () => {
  it('flags an object with message but no code', () => {
    const obj = firstObjectLiteral('const x = ({ message: e.message });');
    expect(objectDropsCode({ node: obj })).toBe(true);
  });

  it('passes when both code and message are present', () => {
    const obj = firstObjectLiteral('const x = ({ code: e.code, message: e.message });');
    expect(objectDropsCode({ node: obj })).toBe(false);
  });

  it('passes when only code is present', () => {
    const obj = firstObjectLiteral('const x = ({ code: e.code });');
    expect(objectDropsCode({ node: obj })).toBe(false);
  });

  it('passes when the object is empty', () => {
    const obj = firstObjectLiteral('const x = ({});');
    expect(objectDropsCode({ node: obj })).toBe(false);
  });

  it('treats a spread (`...e`) as forwarding code through', () => {
    const obj = firstObjectLiteral('const x = ({ ...e, message: "x" });');
    expect(objectDropsCode({ node: obj })).toBe(false);
  });

  it('recognises shorthand property assignment (`{ message }`)', () => {
    const obj = firstObjectLiteral('const x = ({ message });');
    expect(objectDropsCode({ node: obj })).toBe(true);
  });

  it('recognises a string-literal key', () => {
    const obj = firstObjectLiteral('const x = ({ "message": e.message });');
    expect(objectDropsCode({ node: obj })).toBe(true);
  });
});

describe('scanSource', () => {
  it('flags inline-return arrow that drops code', () => {
    const source = [
      'export function foo() {',
      '  return result.mapErr((e) => ({ message: e.message }));',
      '}',
    ].join('\n');
    const violations = scanSource({ relPath: 'packages/x/src/foo.ts', source });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.file).toBe('packages/x/src/foo.ts');
  });

  it('flags block-body arrow that drops code', () => {
    const source = [
      'export function foo() {',
      '  return result.mapErr((e) => {',
      '    return { message: e.message };',
      '  });',
      '}',
    ].join('\n');
    const violations = scanSource({ relPath: 'a.ts', source });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
  });

  it('does not flag a mapErr that preserves code', () => {
    const source = 'result.mapErr((e) => ({ code: e.code, message: e.message }));';
    expect(scanSource({ relPath: 'a.ts', source })).toEqual([]);
  });

  it('does not flag mapErr that returns via a factory call (not an object literal)', () => {
    const source = 'result.mapErr((e) => SlackErrors.upstreamFailure(e.message));';
    expect(scanSource({ relPath: 'a.ts', source })).toEqual([]);
  });

  it('does not flag prose inside comments — AST never sees `.mapErr(...)` text in comments', () => {
    const source = [
      '// Note: .mapErr((e) => ({ message: e.message })) is what we ban.',
      '/* .mapErr((e) => ({ message: "still in a comment" })) */',
      'const noop = 1;',
    ].join('\n');
    expect(scanSource({ relPath: 'a.ts', source })).toEqual([]);
  });

  it('does not flag `.mapErr` inside a string literal', () => {
    const source = "const help = 'use .mapErr((e) => ({ message: e.message })) like this';";
    expect(scanSource({ relPath: 'a.ts', source })).toEqual([]);
  });

  it('flags multiple violations in the same file', () => {
    const source = [
      'a.mapErr((e) => ({ message: e.message }));',
      'b.mapErr((e) => ({ message: e.message }));',
    ].join('\n');
    const violations = scanSource({ relPath: 'a.ts', source });
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.line)).toEqual([1, 2]);
  });

  it('ignores nested object literals that are not the callback return', () => {
    // The inner `{ message: 'x' }` is an argument, not a returned object,
    // and `.someOtherCall` is not `.mapErr`. Make sure we don't false-positive.
    const source = "logger.warn({ message: 'x' });";
    expect(scanSource({ relPath: 'a.ts', source })).toEqual([]);
  });

  it('handles non-Identifier callee chains (e.g. `(getResult()).mapErr(...)`)', () => {
    const source = '(getResult()).mapErr((e) => ({ message: e.message }));';
    const violations = scanSource({ relPath: 'a.ts', source });
    expect(violations).toHaveLength(1);
  });
});
