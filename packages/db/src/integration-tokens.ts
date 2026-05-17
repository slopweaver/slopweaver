/**
 * Read/write helpers for integration credentials supplied via
 * `slopweaver connect`. This module is the single source of truth for
 * "is integration X connected, and what's its token?" — the CLI
 * subcommands write here, the polling layer reads here.
 *
 * Storage split: the secret lives in the OS keychain (see
 * `./keychain.ts`), keyed by `slopweaver / <integration>`. The
 * `integration_tokens` SQLite row tracks *presence* (slug, account
 * label, timestamps) and is the only thing `loadIntegrationToken`
 * consults to answer "is X connected?". Keeping this helper in
 * @slopweaver/db rather than apps/mcp-local means non-binary callers
 * (smoke tests, future cloud tier) reuse the same surface.
 *
 * The integration slug is plain `string` here, matching `upsertEvidence`
 * / `markPollStarted` — the constraint to `'github' | 'slack'` is a
 * CLI-level boundary, not a storage one.
 */

import type { DatabaseError } from '@slopweaver/errors';
import { errAsync, okAsync, type ResultAsync } from '@slopweaver/errors';
import { eq } from 'drizzle-orm';
import type { SlopweaverDatabase } from './index.ts';
import {
  deleteKeychainToken,
  type KeychainAdapter,
  type KeychainError,
  loadKeychainToken,
  saveKeychainToken,
} from './keychain.ts';
import { safeQuery } from './safe-query.ts';
import { integrationTokens } from './schema/integration-tokens.ts';

interface StderrWriter {
  write(message: string): void;
}

export type LoadIntegrationTokenArgs = {
  db: SlopweaverDatabase;
  integration: string;
  keychainAdapter?: KeychainAdapter;
  stderr?: StderrWriter;
};

export type LoadIntegrationTokenResult = {
  token: string;
  accountLabel: string | null;
};

/**
 * Returns the stored token for `integration`, or `null` if no row exists
 * (not connected) or if the SQLite row exists but the keychain entry is
 * missing (stale row from a pre-keychain install or a manually-deleted
 * entry). In the stale-row case a one-line hint is written to `stderr`
 * pointing at `slopweaver connect <integration>` as the recovery path —
 * pre-alpha auto-migration is intentionally out of scope.
 *
 * Polling code must treat `null` as "not connected — skip this
 * integration" rather than as an error, so the local binary can run
 * partially-configured. `Err` is reserved for actual database / keychain
 * failures (not for "missing" semantics).
 */
export function loadIntegrationToken({
  db,
  integration,
  keychainAdapter,
  stderr = process.stderr,
}: LoadIntegrationTokenArgs): ResultAsync<LoadIntegrationTokenResult | null, DatabaseError | KeychainError> {
  return safeQuery({
    execute: () => {
      const row = db
        .select({
          accountLabel: integrationTokens.accountLabel,
        })
        .from(integrationTokens)
        .where(eq(integrationTokens.integration, integration))
        .get();
      return row ?? null;
    },
  }).andThen<LoadIntegrationTokenResult | null, DatabaseError | KeychainError>((row) => {
    if (row === null) return okAsync(null);
    return loadKeychainToken({
      integration,
      ...(keychainAdapter ? { adapter: keychainAdapter } : {}),
    }).map((kcToken) => {
      if (kcToken === null) {
        stderr.write(
          `slopweaver: ${integration} token missing from keychain — run 'slopweaver connect ${integration}' to migrate\n`,
        );
        return null;
      }
      return { token: kcToken, accountLabel: row.accountLabel };
    });
  });
}

export type SaveIntegrationTokenArgs = {
  db: SlopweaverDatabase;
  integration: string;
  token: string;
  accountLabel: string | null;
  now?: () => number;
  keychainAdapter?: KeychainAdapter;
};

/**
 * Persists a connect-flow token. The secret is written to the keychain
 * first; only on success is the SQLite presence row upserted. If the
 * upsert then fails (disk full, file lock, corruption), a best-effort
 * `deleteKeychainToken` cleans up the orphan so `loadIntegrationToken`
 * doesn't end up in a split-brain "no row, but secret in keychain"
 * state. Either branch of the cleanup re-surfaces the original DB
 * error — a cleanup-side failure must not mask the actual problem the
 * caller needs to see.
 *
 * On re-connect the existing `created_at_ms` is preserved (kept out of
 * the conflict-update set) while `account_label` and `updated_at_ms`
 * are refreshed. Mirrors the `markPollStarted` pattern in
 * @slopweaver/integrations-core.
 */
export function saveIntegrationToken({
  db,
  integration,
  token,
  accountLabel,
  now = () => Date.now(),
  keychainAdapter,
}: SaveIntegrationTokenArgs): ResultAsync<void, DatabaseError | KeychainError> {
  const keychainArgs = { integration, ...(keychainAdapter ? { adapter: keychainAdapter } : {}) };
  return saveKeychainToken({
    ...keychainArgs,
    token,
  }).andThen<void, DatabaseError | KeychainError>(() =>
    safeQuery({
      execute: () => {
        const stamp = now();
        db.insert(integrationTokens)
          .values({
            integration,
            accountLabel,
            createdAtMs: stamp,
            updatedAtMs: stamp,
          })
          .onConflictDoUpdate({
            target: integrationTokens.integration,
            set: {
              accountLabel,
              updatedAtMs: stamp,
            },
          })
          .run();
      },
    }).orElse((dbError) => {
      const surface = (): ResultAsync<void, DatabaseError | KeychainError> => errAsync(dbError);
      return deleteKeychainToken(keychainArgs).andThen(surface).orElse(surface);
    }),
  );
}
