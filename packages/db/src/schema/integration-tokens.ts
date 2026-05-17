/**
 * `integration_tokens` table — presence record for credentials supplied via
 * `slopweaver connect`. One row per integration; the integration slug is
 * the primary key.
 *
 * The secret itself lives in the OS keychain (`slopweaver / <integration>`,
 * see `packages/db/src/keychain.ts`). This row tracks *whether* a token
 * exists, plus the display metadata needed to answer "which account?"
 * without round-tripping to the upstream API. Multi-account-per-integration
 * and token rotation are explicit follow-ups, not v1 scope.
 *
 * `account_label` is a human-readable identifier captured at connect time
 * (e.g. the GitHub login or the Slack workspace name) so subsequent CLI
 * surfaces — `doctor`, future `status` — can show *which* account is wired up.
 */

import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

export const integrationTokens = sqliteTable('integration_tokens', {
  /** Integration slug — primary key, one row per integration. */
  integration: text('integration').primaryKey(),
  /** Display label captured at connect time (github login, slack workspace name); null if validation didn't yield one. */
  accountLabel: text('account_label'),
  /** Epoch ms when this row was first inserted. */
  createdAtMs: integer('created_at_ms', { mode: 'number' }).notNull(),
  /** Epoch ms when this row was last updated (every successful re-connect bumps this). */
  updatedAtMs: integer('updated_at_ms', { mode: 'number' }).notNull(),
});
