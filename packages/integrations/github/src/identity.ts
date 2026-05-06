/**
 * Fetches the authenticated user's GitHub profile and upserts a row into
 * `identity_graph`.
 *
 * For v1, `canonical_id` is the sentinel `github:${external_id}`. When
 * the multi-integration merge UI lands (future work), other integrations'
 * identities can be linked by reusing this canonical_id, or rewritten to
 * a UUID and back-linked.
 */

import { identityGraph, type SlopweaverDatabase } from '@slopweaver/db';
import { sql } from 'drizzle-orm';
import { githubFetch } from './client.ts';
import type { GithubUser } from './types.ts';

const INTEGRATION = 'github';

export type FetchIdentityArgs = {
  db: SlopweaverDatabase;
  token: string;
  now?: () => number;
};

export type FetchIdentityResult = {
  canonicalId: string;
  externalId: string;
};

export async function fetchIdentity({
  db,
  token,
  now = () => Date.now(),
}: FetchIdentityArgs): Promise<FetchIdentityResult> {
  const { body } = await githubFetch({ token, path: '/user' });
  const user = body as GithubUser;
  const externalId = String(user.id);
  const canonicalId = `${INTEGRATION}:${externalId}`;
  const stamp = now();

  db.insert(identityGraph)
    .values({
      canonicalId,
      integration: INTEGRATION,
      externalId,
      username: user.login,
      displayName: user.name,
      profileUrl: user.html_url,
      createdAtMs: stamp,
      updatedAtMs: stamp,
    })
    .onConflictDoUpdate({
      target: [identityGraph.integration, identityGraph.externalId],
      set: {
        username: user.login,
        displayName: user.name,
        profileUrl: user.html_url,
        updatedAtMs: sql`excluded.updated_at_ms`,
      },
    })
    .run();

  return { canonicalId, externalId };
}
