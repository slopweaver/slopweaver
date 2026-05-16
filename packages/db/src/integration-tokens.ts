/**
 * Read/write helpers for the `integration_tokens` table — the single source
 * of truth for credentials supplied by `slopweaver connect`.
 *
 * The CLI subcommands write here; the polling layer (and future `start_session`
 * tools) read here. Keeping this surface in @slopweaver/db rather than
 * apps/mcp-local means non-binary callers (smoke tests, future cloud tier)
 * can reuse the same helpers without depending on the CLI app.
 *
 * The integration slug is plain `string` here, matching `upsertEvidence` /
 * `markPollStarted` — the constraint to `'github' | 'slack'` is a CLI-level
 * boundary, not a storage one.
 */

import type { DatabaseError, ResultAsync } from '@slopweaver/errors';
import { eq } from 'drizzle-orm';
import type { SlopweaverDatabase } from './index.ts';
import { safeQuery } from './safe-query.ts';
import { integrationTokens } from './schema/integration-tokens.ts';

export type LoadIntegrationTokenArgs = {
  db: SlopweaverDatabase;
  integration: string;
};

export type LoadIntegrationTokenResult = {
  token: string;
  accountLabel: string | null;
};

/**
 * Returns the stored token for `integration`, or `null` if no row exists.
 *
 * Polling code must treat `null` as "not connected — skip this integration"
 * rather than treating it as an error, so the local binary can run
 * partially-configured (e.g. user has connected GitHub but not Slack yet).
 * `Err` is reserved for actual database failures.
 */
export function loadIntegrationToken({
  db,
  integration,
}: LoadIntegrationTokenArgs): ResultAsync<LoadIntegrationTokenResult | null, DatabaseError> {
  return safeQuery({
    execute: () => {
      const row = db
        .select({
          token: integrationTokens.token,
          accountLabel: integrationTokens.accountLabel,
        })
        .from(integrationTokens)
        .where(eq(integrationTokens.integration, integration))
        .get();
      return row ?? null;
    },
  });
}

export type SaveIntegrationTokenArgs = {
  db: SlopweaverDatabase;
  integration: string;
  token: string;
  accountLabel: string | null;
  now?: () => number;
};

/**
 * Upserts a token row. On re-connect the existing `created_at_ms` is preserved
 * (kept out of the conflict-update set) while `token`, `account_label`, and
 * `updated_at_ms` are refreshed. Mirrors the `markPollStarted` pattern in
 * @slopweaver/integrations-core.
 */
export function saveIntegrationToken({
  db,
  integration,
  token,
  accountLabel,
  now = () => Date.now(),
}: SaveIntegrationTokenArgs): ResultAsync<void, DatabaseError> {
  return safeQuery({
    execute: () => {
      const stamp = now();
      db.insert(integrationTokens)
        .values({
          integration,
          token,
          accountLabel,
          createdAtMs: stamp,
          updatedAtMs: stamp,
        })
        .onConflictDoUpdate({
          target: integrationTokens.integration,
          set: {
            token,
            accountLabel,
            updatedAtMs: stamp,
          },
        })
        .run();
    },
  });
}
