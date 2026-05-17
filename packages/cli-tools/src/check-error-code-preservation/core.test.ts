import { describe, expect, it } from 'vitest';
import { isCodeDropped, scanFileLines } from './core.ts';

describe('isCodeDropped', () => {
  it('flags an object literal with message but no code', () => {
    expect(isCodeDropped({ objectBody: ' message: e.message ' })).toBe(true);
  });

  it('passes when both code and message are preserved', () => {
    expect(isCodeDropped({ objectBody: ' code: e.code, message: e.message ' })).toBe(false);
  });

  it('passes when only code is present (no message)', () => {
    expect(isCodeDropped({ objectBody: ' code: e.code ' })).toBe(false);
  });

  it('passes when the body is empty', () => {
    expect(isCodeDropped({ objectBody: '' })).toBe(false);
  });
});

describe('scanFileLines', () => {
  it('flags inline-return arrow that drops code', () => {
    const lines = [
      'export function foo() {',
      '  return result.mapErr((e) => ({ message: e.message }));',
      '}',
    ];
    const violations = scanFileLines({ relPath: 'packages/x/src/foo.ts', lines });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
    expect(violations[0]?.file).toBe('packages/x/src/foo.ts');
  });

  it('flags block-body arrow that drops code', () => {
    const lines = [
      'export function foo() {',
      '  return result.mapErr((e) => {',
      '    return { message: e.message };',
      '  });',
      '}',
    ];
    const violations = scanFileLines({ relPath: 'a.ts', lines });
    expect(violations).toHaveLength(1);
    expect(violations[0]?.line).toBe(2);
  });

  it('does not flag a mapErr that preserves code', () => {
    const lines = ['result.mapErr((e) => ({ code: e.code, message: e.message }))'];
    expect(scanFileLines({ relPath: 'a.ts', lines })).toEqual([]);
  });

  it('does not flag mapErr that returns a typed error via factory (no inline object)', () => {
    const lines = ['result.mapErr((e) => SlackErrors.upstreamFailure(e.message))'];
    expect(scanFileLines({ relPath: 'a.ts', lines })).toEqual([]);
  });

  it('does not flag plain prose containing "mapErr"', () => {
    const lines = ['// Note: we use mapErr to lift errors.'];
    expect(scanFileLines({ relPath: 'a.ts', lines })).toEqual([]);
  });

  it('flags multiple violations in the same file', () => {
    const lines = [
      'a.mapErr((e) => ({ message: e.message }));',
      'b.mapErr((e) => ({ message: e.message }));',
    ];
    const violations = scanFileLines({ relPath: 'a.ts', lines });
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.line)).toEqual([1, 2]);
  });
});
