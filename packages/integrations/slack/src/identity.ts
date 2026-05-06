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
import { type SlopweaverDatabase, identityGraph } from '@slopweaver/db';
import { sql } from 'drizzle-orm';
import { createSlackClient } from './client.ts';

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

export async function fetchIdentity({
  db,
  token,
  client,
  now = Date.now,
}: FetchIdentityArgs): Promise<FetchIdentityResult> {
  const slack = client ?? createSlackClient({ token });

  const auth = await slack.auth.test();
  // biome-ignore lint/style/noNonNullAssertion: SDK contract guarantees user_id on ok:true
  const userId = auth.user_id!;
  // biome-ignore lint/style/noNonNullAssertion: SDK contract guarantees team_id on ok:true
  const teamId = auth.team_id!;
  const canonicalId = `${INTEGRATION}:${teamId}:${userId}`;

  const usersInfo = await slack.users.info({ user: userId });
  const user = usersInfo.user;
  const profile = user?.profile;
  const username = user?.name ?? auth.user ?? null;
  const displayName = profile?.display_name?.trim() || profile?.real_name?.trim() || null;
  const profileUrl = auth.url ? `${stripTrailingSlash(auth.url)}/team/${userId}` : null;

  const stamp = now();

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
      // canonical_id and created_at_ms are preserved across re-runs by being
      // absent from the conflict-update set.
      set: {
        username,
        displayName,
        profileUrl,
        updatedAtMs: sql`excluded.updated_at_ms`,
      },
    })
    .run();

  return { canonicalId, externalId: userId };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
