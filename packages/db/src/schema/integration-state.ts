/**
 * `integration_state` table — per-integration polling bookkeeping.
 *
 * One row per connected integration. Absence of a row means "never polled".
 * `cursor` is opaque (integration-defined: a GraphQL cursor, an ETag, a
 * timestamp); only the integration's poll loop interprets it.
 *
 * `last_poll_started_at_ms` and `last_poll_completed_at_ms` are tracked
 * separately so doctor / status views can detect a poll that started but
 * never finished (started > completed).
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const integrationState = sqliteTable('integration_state', {
  /** Integration slug — primary key, one row per integration. */
  integration: text('integration').primaryKey(),
  /** Integration-defined opaque cursor; nullable until first successful poll. */
  cursor: text('cursor'),
  /** Epoch ms when the most recent poll attempt began. Null if no poll has ever started. */
  lastPollStartedAtMs: integer('last_poll_started_at_ms', { mode: 'number' }),
  /** Epoch ms when the most recent poll attempt completed successfully. Null if no poll has ever completed. */
  lastPollCompletedAtMs: integer('last_poll_completed_at_ms', { mode: 'number' }),
  /** When this integration row was first inserted (epoch ms). */
  createdAtMs: integer('created_at_ms', { mode: 'number' }).notNull(),
  /** When this integration row was last updated (epoch ms). */
  updatedAtMs: integer('updated_at_ms', { mode: 'number' }).notNull(),
});
