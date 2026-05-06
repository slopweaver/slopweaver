/**
 * Search-based pollers for GitHub PRs / issues / mentions.
 *
 * All three call `octokit.rest.search.issuesAndPullRequests` with different
 * qualifiers. Results are upserted into `evidence_log`; `integration_state`
 * tracks poll start/finish timestamps and an `updated_at` watermark for use
 * as the next poll's `since`.
 *
 * `external_id` is kind-prefixed (`pr_`, `issue_`, `mention_`) so a single
 * GitHub item observed via both `involves:@me` and `mentions:@me` queries
 * occupies separate rows in `evidence_log`.
 */

import type { RestEndpointMethodTypes } from '@octokit/rest';
import type { SlopweaverDatabase } from '@slopweaver/db';
import { createGithubClient } from './client.ts';
import { markPollCompleted, markPollStarted, upsertEvidence } from './upsert.ts';

const INTEGRATION = 'github';
const PER_PAGE = 50;

type SearchItem =
  RestEndpointMethodTypes['search']['issuesAndPullRequests']['response']['data']['items'][number];

export type PollArgs = {
  db: SlopweaverDatabase;
  token: string;
  since: Date | null;
  now?: () => number;
};

/**
 * `pollMentions` requires the username explicitly because GitHub's
 * `mentions:` qualifier rejects the `@me` shortcut (only `involves:` /
 * `assignee:` / `author:` accept it). Callers obtain the username from
 * `fetchIdentity` and pass it through.
 *
 * v1 covers PR mentions only — `/search/issues` now requires `is:pr` or
 * `is:issue` in the query, and we ship just `is:pr`. Issue mentions are a
 * follow-up.
 */
export type PollMentionsArgs = PollArgs & { username: string };

export type PollResult = {
  fetched: number;
  newCursor: string | null;
};

export function pollPullRequests(args: PollArgs): Promise<PollResult> {
  return runSearch({ ...args, kind: 'pull_request', qualifier: 'is:pr involves:@me' });
}

export function pollIssues(args: PollArgs): Promise<PollResult> {
  return runSearch({ ...args, kind: 'issue', qualifier: 'is:issue involves:@me' });
}

export function pollMentions(args: PollMentionsArgs): Promise<PollResult> {
  return runSearch({
    ...args,
    kind: 'mention',
    qualifier: `is:pr mentions:${args.username}`,
  });
}

async function runSearch({
  db,
  token,
  since,
  kind,
  qualifier,
  now = () => Date.now(),
}: PollArgs & { kind: string; qualifier: string }): Promise<PollResult> {
  const startedAt = now();
  markPollStarted({ db, integration: INTEGRATION, now: startedAt });

  const sinceClause = since ? ` updated:>${since.toISOString()}` : '';
  const octokit = createGithubClient({ token });
  const { data } = await octokit.rest.search.issuesAndPullRequests({
    q: `${qualifier}${sinceClause}`,
    per_page: PER_PAGE,
    sort: 'updated',
    order: 'desc',
  });

  const items = data.items ?? [];
  const observedAt = now();

  for (const item of items) {
    upsertEvidence({
      db,
      integration: INTEGRATION,
      externalId: externalIdFor({ item, kind }),
      kind,
      title: item.title,
      body: item.body ?? null,
      citationUrl: item.html_url,
      payloadJson: JSON.stringify(item),
      occurredAtMs: Date.parse(item.updated_at),
      now: observedAt,
    });
  }

  // When the poll returns zero items, preserve the prior watermark (`since`)
  // instead of resetting the cursor to null — otherwise the next poll would
  // backfill from the beginning unnecessarily.
  const newCursor = items[0]?.updated_at ?? since?.toISOString() ?? null;
  markPollCompleted({ db, integration: INTEGRATION, cursor: newCursor, now: observedAt });
  return { fetched: items.length, newCursor };
}

function externalIdFor({ item, kind }: { item: SearchItem; kind: string }): string {
  const prefix = kind === 'pull_request' ? 'pr' : kind === 'issue' ? 'issue' : 'mention';
  return `${prefix}_${item.id}`;
}
