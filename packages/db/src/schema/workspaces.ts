/**
 * `workspaces` table — single-row "what is this SlopWeaver instance about".
 *
 * v1 ships with exactly one workspace; the CHECK constraint enforces
 * `id = 1` so accidental multi-workspace inserts fail loudly. When
 * multi-workspace lands later, the CHECK is dropped and `evidence_log` /
 * `identity_graph` uniqueness widens to include `workspace_id`.
 */

import { sql } from 'drizzle-orm';
import { check, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const workspaces = sqliteTable(
  'workspaces',
  {
    /** Always 1 in v1 (CHECK constraint enforced below). */
    id: integer('id').primaryKey(),
    /** Display name. Defaults to 'default' so callers can omit it on first insert. */
    name: text('name').notNull().default('default'),
    /** Epoch ms when the workspace row was inserted. */
    createdAtMs: integer('created_at_ms', { mode: 'number' }).notNull(),
    /** Epoch ms when the workspace row was last updated. */
    updatedAtMs: integer('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    /** Single-row enforcement for v1. Drop when multi-workspace lands. */
    check('workspaces_single_row', sql`${table.id} = 1`),
  ],
);
