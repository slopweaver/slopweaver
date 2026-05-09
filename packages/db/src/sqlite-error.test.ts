import { describe, expect, it } from 'vitest';
import { extractSqliteErrorShape } from './sqlite-error.ts';

describe('extractSqliteErrorShape', () => {
  it('returns null for non-error values', () => {
    expect(extractSqliteErrorShape({ error: undefined })).toBeNull();
    expect(extractSqliteErrorShape({ error: null })).toBeNull();
    expect(extractSqliteErrorShape({ error: 42 })).toBeNull();
  });

  it('extracts SQLITE_* code and message from a top-level SqliteError-shaped object', () => {
    const error = Object.assign(new Error('UNIQUE constraint failed: users.email'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });

    const shape = extractSqliteErrorShape({ error });

    expect(shape).toEqual({
      code: 'SQLITE_CONSTRAINT_UNIQUE',
      message: 'UNIQUE constraint failed: users.email',
      table: 'users',
      constraint: 'email',
    });
  });

  it('parses table-only when constraint message has no column', () => {
    const error = Object.assign(new Error('FOREIGN KEY constraint failed'), {
      code: 'SQLITE_CONSTRAINT_FOREIGNKEY',
    });

    const shape = extractSqliteErrorShape({ error });

    expect(shape?.code).toBe('SQLITE_CONSTRAINT_FOREIGNKEY');
    expect(shape?.message).toBe('FOREIGN KEY constraint failed');
    expect(shape?.table).toBeUndefined();
    expect(shape?.constraint).toBeUndefined();
  });

  it('walks the .cause chain to find the SqliteError when wrapped', () => {
    const inner = Object.assign(new Error('UNIQUE constraint failed: t.col'), {
      code: 'SQLITE_CONSTRAINT_UNIQUE',
    });
    const wrapped = new Error('drizzle: failed to insert', { cause: inner });

    const shape = extractSqliteErrorShape({ error: wrapped });

    expect(shape?.code).toBe('SQLITE_CONSTRAINT_UNIQUE');
    expect(shape?.table).toBe('t');
    expect(shape?.constraint).toBe('col');
  });

  it('rejects codes that do not match SQLITE_* and falls back to message-only', () => {
    const error = Object.assign(new Error('something broke'), { code: 'EBADREQ' });
    const shape = extractSqliteErrorShape({ error });

    expect(shape?.code).toBeUndefined();
    expect(shape?.message).toBe('something broke');
  });

  it('returns a shape carrying just the message when no code is present anywhere', () => {
    const error = new Error('plain error, no code');
    const shape = extractSqliteErrorShape({ error });

    expect(shape).toEqual({ message: 'plain error, no code' });
  });
});
