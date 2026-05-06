/**
 * In-memory SQLite handle for slack package tests.
 *
 * Mirrors the pattern used in `packages/db/src/db.test.ts` and
 * `packages/mcp-server/src/server.test.ts` — a fresh `:memory:` database with
 * migrations applied, isolated per test.
 */

import { type CreateDbHandle, createDb } from '@slopweaver/db';

export function openMemoryDb(): CreateDbHandle {
  return createDb({ path: ':memory:' });
}
