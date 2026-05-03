/**
 * `identity_graph` table — maps platform identities to canonical people.
 *
 * Each row is one platform identity: "this GitHub login is part of canonical
 * person X." Multiple rows can share `canonical_id` to merge identities
 * across integrations. `username` / `display_name` / `profile_url` are
 * snapshots taken at link time; refresh on subsequent polls.
 *
 * `(integration, external_id)` is unique — a single platform identity
 * cannot belong to two canonical people simultaneously.
 */

import { index, integer, sqliteTable, text, unique } from 'drizzle-orm/sqlite-core';

export const identityGraph = sqliteTable(
  'identity_graph',
  {
    /** Surrogate primary key. */
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Slop-internal stable id for the canonical person (typically a UUID). Many rows may share this. */
    canonicalId: text('canonical_id').notNull(),
    /** Integration slug this identity comes from, e.g. 'github'. */
    integration: text('integration').notNull(),
    /** Integration-native user id. */
    externalId: text('external_id').notNull(),
    /** Optional handle / login on the source platform. */
    username: text('username'),
    /** Optional human-readable display name (snapshot, may go stale). */
    displayName: text('display_name'),
    /** Optional URL to the identity's profile on the source platform. */
    profileUrl: text('profile_url'),
    /** When this identity was first linked (epoch ms). */
    createdAtMs: integer('created_at_ms', { mode: 'number' }).notNull(),
    /** When this identity row was last refreshed (epoch ms). */
    updatedAtMs: integer('updated_at_ms', { mode: 'number' }).notNull(),
  },
  (table) => [
    /** A given platform identity belongs to exactly one canonical person. */
    unique('identity_graph_integration_external_id_unique').on(table.integration, table.externalId),
    /** Fast "give me all platform identities for this canonical person" lookup. */
    index('identity_graph_canonical_id_idx').on(table.canonicalId),
  ],
);
