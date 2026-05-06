/**
 * Search-based pollers for GitHub PRs / issues / mentions.
 *
 * All three call the same `/search/issues` endpoint with different qualifiers.
 * Results are upserted into `evidence_log`; `integration_state` tracks poll
 * start/finish timestamps and an `updated_at` watermark for use as the next
 * poll's `since`.
 *
 * `external_id` is kind-prefixed (`pr_`, `issue_`, `mention_`) so a same-id
 * mention cannot collide with the underlying PR/issue row in evidence_log
 * — a single GitHub item can legitimately be observed via both the
 * `involves:@me` and `mentions:@me` queries.
 */

import type { SlopweaverDatabase } from '@slopweaver/db';
import { githubFetch } from './client.ts';
import type { GithubSearchIssue, GithubSearchResponse } from './types.ts';
import { markPollCompleted, markPollStarted, upsertEvidence } from './upsert.ts';

const INTEGRATION = 'github';
const PER_PAGE = 50;

export type PollArgs = {
  db: SlopweaverDatabase;
  token: string;
  since: Date | null;
  now?: () => number;
};

/**
 * `pollMentions` requires the username explicitly because GitHub's
 * `mentions:` qualifier rejects the `@me` shortcut with a 422 (only
 * `involves:` / `assignee:` / `author:` accept `@me`). Callers obtain the
 * username from `fetchIdentity` and pass it through.
 *
 * v1 covers PR mentions only — `/search/issues` now requires `is:pr` or
 * `is:issue` in the query, and we ship just `is:pr` here. Issue mentions
 * are a follow-up.
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
  return runSearch({ ...args, kind: 'mention', qualifier: `is:pr mentions:${args.username}` });
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
  const search = new URLSearchParams({
    q: `${qualifier}${sinceClause}`,
    per_page: String(PER_PAGE),
    sort: 'updated',
    order: 'desc',
  });

  const { body } = await githubFetch({ token, path: '/search/issues', search });
  const data = body as GithubSearchResponse;
  const items = data.items ?? [];
  const observedAt = now();

  for (const item of items) {
    upsertEvidence({
      db,
      integration: INTEGRATION,
      externalId: externalIdFor({ item, kind }),
      kind,
      title: item.title,
      body: item.body,
      citationUrl: item.html_url,
      payloadJson: JSON.stringify(item),
      occurredAtMs: Date.parse(item.updated_at),
      now: observedAt,
    });
  }

  const newCursor = items[0]?.updated_at ?? null;
  markPollCompleted({ db, integration: INTEGRATION, cursor: newCursor, now: observedAt });
  return { fetched: items.length, newCursor };
}

function externalIdFor({ item, kind }: { item: GithubSearchIssue; kind: string }): string {
  const prefix = kind === 'pull_request' ? 'pr' : kind === 'issue' ? 'issue' : 'mention';
  return `${prefix}_${item.id}`;
}
