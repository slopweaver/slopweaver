/**
 * `integration_tokens` table — credentials supplied via `slopweaver connect`.
 *
 * One row per integration; the integration slug is the primary key. v1 stores
 * the raw token verbatim — encryption-at-rest, multi-account-per-integration,
 * and rotation are explicit follow-ups, not v1 scope.
 *
 * `account_label` is a human-readable identifier captured at connect time
 * (e.g. the GitHub login or the Slack workspace name) so subsequent CLI
 * surfaces — `doctor`, future `status` — can show *which* account is wired up
 * without needing to round-trip back to the upstream API.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const integrationTokens = sqliteTable('integration_tokens', {
  /** Integration slug — primary key, one row per integration. */
  integration: text('integration').primaryKey(),
  /** Raw token as supplied by the user. Plaintext for v1; encryption-at-rest is future work. */
  token: text('token').notNull(),
  /** Display label captured at connect time (github login, slack workspace name); null if validation didn't yield one. */
  accountLabel: text('account_label'),
  /** Epoch ms when this row was first inserted. */
  createdAtMs: integer('created_at_ms', { mode: 'number' }).notNull(),
  /** Epoch ms when this row was last updated (every successful re-connect bumps this). */
  updatedAtMs: integer('updated_at_ms', { mode: 'number' }).notNull(),
});
