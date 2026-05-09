/**
 * Fetch the auth'd user/bot identity from Slack and upsert into `identity_graph`.
 *
 * Uses `auth.test` to discover the user_id behind the token, then `users.info`
 * to enrich with display name + avatar. Writes a single row keyed on
 * `(integration='slack', external_id=<user_id>)`.
 *
 * `canonical_id` is deterministic: `slack:<team_id>:<user_id>`. Workspace-
 * scoped, so two machines connecting to the same workspace agree on the
 * canonical id by construction. Mirrors github's `github:<id>` strategy
 * (#33), extended with team_id because Slack user ids are workspace-scoped.
 *
 * Why `auth.test` + `users.info` instead of `users.identity`: bot tokens
 * (`xoxb-`) cannot call `users.identity` (which requires the user-token
 * `identity.basic` scope). The two-step here works for both bot and user
 * tokens.
 */

import type { WebClient } from '@slack/web-api';
import { identityGraph, safeQuery, type SlopweaverDatabase } from '@slopweaver/db';
import { errAsync, type ResultAsync } from '@slopweaver/errors';
import { sql } from 'drizzle-orm';
import { createSlackClient } from './client.ts';
import { fromDatabaseError, safeSlackCall, type SlackError } from './errors.ts';

const INTEGRATION = 'slack';

export type FetchIdentityArgs = {
  db: SlopweaverDatabase;
  token: string;
  client?: WebClient;
  now?: () => number;
};

export type FetchIdentityResult = {
  canonicalId: string;
  externalId: string;
};

export function fetchIdentity({
  db,
  token,
  client,
  now = Date.now,
}: FetchIdentityArgs): ResultAsync<FetchIdentityResult, SlackError> {
  let slack: WebClient;
  if (client) {
    slack = client;
  } else {
    const created = createSlackClient({ token });
    if (created.isErr()) return errAsync(created.error);
    slack = created.value;
  }

  return safeSlackCall({
    execute: () => slack.auth.test(),
    endpoint: 'auth.test',
  })
    .andThen((auth) => {
      // biome-ignore lint/style/noNonNullAssertion: SDK contract guarantees user_id on ok:true
      const userId = auth.user_id!;
      // biome-ignore lint/style/noNonNullAssertion: SDK contract guarantees team_id on ok:true
      const teamId = auth.team_id!;
      const canonicalId = `${INTEGRATION}:${teamId}:${userId}`;
      const profileUrl = auth.url ? `${stripTrailingSlash(auth.url)}/team/${userId}` : null;
      return safeSlackCall({
        execute: () => slack.users.info({ user: userId }),
        endpoint: 'users.info',
      }).map((usersInfo) => ({ auth, userId, canonicalId, profileUrl, usersInfo }));
    })
    .andThen(({ auth, userId, canonicalId, profileUrl, usersInfo }) => {
      const user = usersInfo.user;
      const profile = user?.profile;
      const username = user?.name ?? auth.user ?? null;
      const displayName = profile?.display_name?.trim() || profile?.real_name?.trim() || null;
      const stamp = now();

      return safeQuery({
        execute: () => {
          db.insert(identityGraph)
            .values({
              canonicalId,
              integration: INTEGRATION,
              externalId: userId,
              username,
              displayName,
              profileUrl,
              createdAtMs: stamp,
              updatedAtMs: stamp,
            })
            .onConflictDoUpdate({
              target: [identityGraph.integration, identityGraph.externalId],
              set: {
                username,
                displayName,
                profileUrl,
                updatedAtMs: sql`excluded.updated_at_ms`,
              },
            })
            .run();
        },
      })
        .mapErr(fromDatabaseError)
        .map(() => ({ canonicalId, externalId: userId }));
    });
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
