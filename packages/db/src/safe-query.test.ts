/**
 * Behaviour tests for `safeQuery`. Drives a real in-memory SQLite via
 * `createDb` so we exercise the actual error shapes better-sqlite3 +
 * Drizzle produce, not synthetic stubs.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createDb } from './index.ts';
import { safeQuery } from './safe-query.ts';
import { integrationTokens } from './schema/integration-tokens.ts';

describe('safeQuery', () => {
  let handle: ReturnType<typeof createDb>;

  beforeEach(() => {
    handle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    handle.close();
  });

  it('returns ok with the query value on success', async () => {
    const result = await safeQuery({
      execute: () => handle.db.select().from(integrationTokens).all(),
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual([]);
    }
  });

  it('returns err with a SQLITE_CONSTRAINT_UNIQUE code on a unique conflict', async () => {
    handle.db
      .insert(integrationTokens)
      .values({
        integration: 'github',
        token: 'gh_xxx',
        accountLabel: null,
        createdAtMs: 1,
        updatedAtMs: 1,
      })
      .run();

    const result = await safeQuery({
      execute: () =>
        handle.db
          .insert(integrationTokens)
          .values({
            integration: 'github',
            token: 'gh_yyy',
            accountLabel: null,
            createdAtMs: 2,
            updatedAtMs: 2,
          })
          .run(),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('SQLITE_CONSTRAINT_PRIMARYKEY');
      expect(result.error.message).toMatch(/constraint failed/);
      expect(result.error.cause).toBeDefined();
    }
  });

  it('returns err carrying the underlying Error when execute throws a non-sqlite error', async () => {
    const cause = new Error('handler blew up before reaching sqlite');
    const result = await safeQuery<unknown>({
      execute: () => {
        throw cause;
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBeUndefined();
      expect(result.error.message).toBe('handler blew up before reaching sqlite');
      expect(result.error.cause).toBe(cause);
    }
  });
});
