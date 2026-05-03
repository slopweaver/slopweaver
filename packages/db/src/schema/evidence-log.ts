/**
 * `evidence_log` table — upserted snapshot of upstream observations.
 *
 * Polling integrations (GitHub, Slack, …) write rows here. Each upstream
 * entity is identified by `(integration, external_id)`, which is enforced
 * unique so re-poll cycles can use `INSERT … ON CONFLICT DO UPDATE` without
 * a SELECT-then-INSERT race.
 *
 * Field naming intentionally aligns with `@slopweaver/contracts`:
 * `integration`, `kind`, `payload_json`, `citation_url`, and `occurred_at`
 * are the wire vocabulary; storing them under matching column names avoids
 * a renaming layer in every consumer.
 *
 * Timestamps are integer epoch milliseconds (JS `Date.now()` semantics).
 * `first_seen_at_ms` / `last_seen_at_ms` are observation timestamps;
 * `occurred_at_ms` is when the upstream event actually happened (may be
 * earlier than `first_seen_at_ms` for backfills).
 */

import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const evidenceLog = sqliteTable(
  'evidence_log',
  {
    /** Surrogate primary key. The wire `EvidenceLogEntry.id` is a string; serialize this integer at the contract boundary. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Source integration slug, e.g. 'github', 'slack'. Matches `Reference.integration` and `Freshness.integration`. */
    integration: text('integration').notNull(),
    /** Integration-native id for the entity, e.g. 'pr_123', a Slack message ts. */
    externalId: text('external_id').notNull(),
    /** Entity kind, e.g. 'pull_request', 'issue', 'message', 'mention'. */
    kind: text('kind').notNull(),
    /** Optional human-displayable URL for the entity. Nullable to match `EvidenceLogEntry.citation_url`. */
    citationUrl: text('citation_url'),
    /** Optional one-line title (PR title, issue title, message preview). */
    title: text('title'),
    /** Optional longer-form body content. */
    body: text('body'),
    /** Verbatim source payload as a JSON string. The replay/audit anchor — never null. */
    payloadJson: text('payload_json').notNull(),
    /** When the upstream event happened (epoch ms). Maps to `EvidenceLogEntry.occurred_at`. */
    occurredAtMs: integer('occurred_at_ms', { mode: 'number' }).notNull(),
    /** When this row was first observed by a poll (epoch ms). */
    firstSeenAtMs: integer('first_seen_at_ms', { mode: 'number' }).notNull(),
    /** When this row was most recently re-observed by a poll (epoch ms); bumped on upsert. */
    lastSeenAtMs: integer('last_seen_at_ms', { mode: 'number' }).notNull(),
    /** When this row was first inserted (epoch ms). */
    createdAtMs: integer('created_at_ms', { mode: 'number' }).notNull(),
    /** When this row was most recently updated (epoch ms). */
    updatedAtMs: integer('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    /** Dedup key. Enables idempotent INSERT … ON CONFLICT DO UPDATE on poll re-fetch. */
    unique('evidence_log_integration_external_id_unique').on(table.integration, table.externalId),
    /** Filter rows by integration + kind (e.g. "all GitHub PRs"). */
    index('evidence_log_integration_kind_idx').on(table.integration, table.kind),
    /** Time-ordered scan by integration (e.g. "what's new in Slack since X"). */
    index('evidence_log_integration_occurred_at_ms_idx').on(table.integration, table.occurredAtMs),
  ],
);
