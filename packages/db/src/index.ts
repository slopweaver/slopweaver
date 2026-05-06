/**
 * @slopweaver/db public entry.
 *
 * Exposes the createDb() helper, the Drizzle table schemas, and the XDG-aware
 * path resolvers. Consumers import this package as TypeScript source — there
 * is no build step.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { type BetterSQLite3Database, drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { resolveDbPath } from './path.ts';
import * as schema from './schema/index.ts';

export * from './integration-tokens.ts';
export * from './path.ts';
export * from './schema/index.ts';

/**
 * Absolute path to the directory holding generated Drizzle migration SQL.
 * Resolved relative to this file at runtime so the helper works regardless
 * of the consumer's cwd.
 */
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

/**
 * better-sqlite3's Database class is exported as a default; the instance
 * type lives at `Database.Database`. Re-aliased here so the createDb return
 * type can name it explicitly (TS4058 otherwise).
 */
export type SqliteHandle = Database.Database;

/**
 * Drizzle wrapper bound to this package's schema barrel. Consumers can use
 * this type to type the `db` field they receive from createDb.
 */
export type SlopweaverDatabase = BetterSQLite3Database<typeof schema>;

/**
 * Handle returned by {@link createDb}. The Drizzle wrapper is the primary
 * surface; `sqlite` is exposed for raw queries, pragmas, and tests; `close`
 * is provided so callers don't have to import better-sqlite3 themselves.
 */
export type CreateDbHandle = {
  db: SlopweaverDatabase;
  sqlite: SqliteHandle;
  close: () => void;
};

/**
 * Open the SlopWeaver SQLite database, run pending Drizzle migrations, and
 * return the handle.
 *
 * Side effects:
 * - Creates the parent directory of `path` if it does not exist (skipped for
 *   the `:memory:` sentinel).
 * - Enables `foreign_keys` pragma on the connection.
 * - Applies any pending migrations from `packages/db/migrations/`.
 *
 * @param path - Optional override; defaults to {@link resolveDbPath}() which
 *   honours XDG_DATA_HOME. Pass `':memory:'` for ephemeral test databases.
 * @returns Handle exposing the Drizzle wrapper, raw better-sqlite3 instance,
 *   and a `close()` shortcut.
 *
 * @example
 * const { db, close } = createDb({ path: ':memory:' });
 * try {
 *   db.insert(evidenceLog).values({ ... }).run();
 * } finally {
 *   close();
 * }
 */
export function createDb({ path = resolveDbPath() }: { path?: string } = {}): CreateDbHandle {
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }

  const sqlite = new Database(path);
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });

  migrate(db, { migrationsFolder });

  return {
    db,
    sqlite,
    close: () => sqlite.close(),
  };
}
