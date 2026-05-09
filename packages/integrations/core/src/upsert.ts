/**
 * Shared upsert helpers writing into `evidence_log` and `integration_state`.
 *
 * `upsertEvidence` collapses INSERT-or-UPDATE on the existing
 * `(integration, external_id)` UNIQUE constraint. On conflict, mutable fields
 * are refreshed and `last_seen_at_ms` / `updated_at_ms` are bumped, but
 * `first_seen_at_ms` / `created_at_ms` are preserved by virtue of being
 * absent from the conflict-update set.
 *
 * `markPollStarted` and `markPollCompleted` track per-integration polling
 * progress. `started_at` is set before the request; `completed_at` is set
 * only on success — divergence between the two is the "poll started but
 * never finished" doctor signal.
 *
 * Generic over `integration: string`. Integration packages call these
 * directly with their slug (`'github'`, `'slack'`, …). All four functions
 * return `ResultAsync<…, DatabaseError>` via `safeQuery`; service callers
 * are responsible for handling the `Err` (typically by translating into
 * their own per-platform error union).
 */

import { evidenceLog, integrationState, safeQuery, type SlopweaverDatabase } from '@slopweaver/db';
import type { DatabaseError, ResultAsync } from '@slopweaver/errors';
import { eq, sql } from 'drizzle-orm';

export type UpsertEvidenceArgs = {
  db: SlopweaverDatabase;
  integration: string;
  externalId: string;
  kind: string;
  title: string | null;
  body: string | null;
  citationUrl: string | null;
  payloadJson: string;
  occurredAtMs: number;
  now: number;
};

export function upsertEvidence({
  db,
  integration,
  externalId,
  kind,
  title,
  body,
  citationUrl,
  payloadJson,
  occurredAtMs,
  now,
}: UpsertEvidenceArgs): ResultAsync<void, DatabaseError> {
  return safeQuery({
    execute: () => {
      db.insert(evidenceLog)
        .values({
          integration,
          externalId,
          kind,
          title,
          body,
          citationUrl,
          payloadJson,
          occurredAtMs,
          firstSeenAtMs: now,
          lastSeenAtMs: now,
          createdAtMs: now,
          updatedAtMs: now,
        })
        .onConflictDoUpdate({
          target: [evidenceLog.integration, evidenceLog.externalId],
          set: {
            kind,
            title,
            body,
            citationUrl,
            payloadJson,
            occurredAtMs,
            lastSeenAtMs: sql`excluded.last_seen_at_ms`,
            updatedAtMs: sql`excluded.updated_at_ms`,
          },
        })
        .run();
    },
  });
}

export function markPollStarted({
  db,
  integration,
  now,
}: {
  db: SlopweaverDatabase;
  integration: string;
  now: number;
}): ResultAsync<void, DatabaseError> {
  return safeQuery({
    execute: () => {
      db.insert(integrationState)
        .values({
          integration,
          cursor: null,
          lastPollStartedAtMs: now,
          lastPollCompletedAtMs: null,
          createdAtMs: now,
          updatedAtMs: now,
        })
        .onConflictDoUpdate({
          target: integrationState.integration,
          set: {
            lastPollStartedAtMs: now,
            updatedAtMs: now,
          },
        })
        .run();
    },
  });
}

/**
 * Returns the number of integration_state rows updated. In normal flow this
 * is 1 (markPollStarted always runs first and creates the row), but a return
 * of 0 means the caller violated the markPollStarted-first contract — useful
 * for assertions in callers that want defense-in-depth.
 */
export function markPollCompleted({
  db,
  integration,
  cursor,
  now,
}: {
  db: SlopweaverDatabase;
  integration: string;
  cursor: string | null;
  now: number;
}): ResultAsync<number, DatabaseError> {
  return safeQuery({
    execute: () => {
      const result = db
        .update(integrationState)
        .set({
          cursor,
          lastPollCompletedAtMs: now,
          updatedAtMs: now,
        })
        .where(eq(integrationState.integration, integration))
        .run();
      return result.changes;
    },
  });
}

export function readCursor({
  db,
  integration,
}: {
  db: SlopweaverDatabase;
  integration: string;
}): ResultAsync<string | null, DatabaseError> {
  return safeQuery({
    execute: () => {
      const row = db
        .select()
        .from(integrationState)
        .where(eq(integrationState.integration, integration))
        .get();
      return row?.cursor ?? null;
    },
  });
}
