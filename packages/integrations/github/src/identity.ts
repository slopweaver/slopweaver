/**
 * Fetches the authenticated user's GitHub profile via Octokit and upserts a
 * row into `identity_graph`.
 *
 * For v1, `canonical_id` is the sentinel `github:${external_id}`. When the
 * multi-integration merge UI lands (future work), other integrations'
 * identities can be linked by reusing this canonical_id, or rewritten to
 * a UUID and back-linked.
 */

import { identityGraph, safeQuery, type SlopweaverDatabase } from '@slopweaver/db';
import type { ResultAsync } from '@slopweaver/errors';
import { sql } from 'drizzle-orm';
import { createGithubClient } from './client.ts';
import { fromDatabaseError, type GithubError, safeGithubCall } from './errors.ts';

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

export function fetchIdentity({
  db,
  token,
  now = () => Date.now(),
}: FetchIdentityArgs): ResultAsync<FetchIdentityResult, GithubError> {
  const octokit = createGithubClient({ token });

  return safeGithubCall({
    execute: () => octokit.rest.users.getAuthenticated(),
    endpoint: 'users.getAuthenticated',
  }).andThen(({ data: user }) => {
    const externalId = String(user.id);
    const canonicalId = `${INTEGRATION}:${externalId}`;
    const stamp = now();

    return safeQuery({
      execute: () => {
        db.insert(identityGraph)
          .values({
            canonicalId,
            integration: INTEGRATION,
            externalId,
            username: user.login,
            displayName: user.name ?? null,
            profileUrl: user.html_url,
            createdAtMs: stamp,
            updatedAtMs: stamp,
          })
          .onConflictDoUpdate({
            target: [identityGraph.integration, identityGraph.externalId],
            set: {
              username: user.login,
              displayName: user.name ?? null,
              profileUrl: user.html_url,
              updatedAtMs: sql`excluded.updated_at_ms`,
            },
          })
          .run();
      },
    })
      .mapErr(fromDatabaseError)
      .map(() => ({ canonicalId, externalId }));
  });
}
