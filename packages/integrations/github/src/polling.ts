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
 *
 * Returns `ResultAsync<PollResult, GithubError>`. Octokit calls flow through
 * `safeGithubCall` which extracts `RequestError.status`; DB writes flow
 * through `safeQuery` with `DatabaseError` mapped to `GithubDatabaseError`
 * via `fromDatabaseError`.
 */

import type { RestEndpointMethodTypes } from '@octokit/rest';
import type { SlopweaverDatabase } from '@slopweaver/db';
import { err, ok, type Result, ResultAsync } from '@slopweaver/errors';
import { markPollCompleted, markPollStarted, upsertEvidence } from '@slopweaver/integrations-core';
import { createGithubClient } from './client.ts';
import { fromDatabaseError, type GithubError, safeGithubCall } from './errors.ts';

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

export function pollPullRequests(args: PollArgs): ResultAsync<PollResult, GithubError> {
  return runSearch({ ...args, kind: 'pull_request', qualifier: 'is:pr involves:@me' });
}

export function pollIssues(args: PollArgs): ResultAsync<PollResult, GithubError> {
  return runSearch({ ...args, kind: 'issue', qualifier: 'is:issue involves:@me' });
}

export function pollMentions(args: PollMentionsArgs): ResultAsync<PollResult, GithubError> {
  return runSearch({
    ...args,
    kind: 'mention',
    qualifier: `is:pr mentions:${args.username}`,
  });
}

function runSearch(
  args: PollArgs & { kind: string; qualifier: string },
): ResultAsync<PollResult, GithubError> {
  return ResultAsync.fromSafePromise(runSearchInner(args)).andThen((r) => r);
}

async function runSearchInner({
  db,
  token,
  since,
  kind,
  qualifier,
  now = () => Date.now(),
}: PollArgs & { kind: string; qualifier: string }): Promise<Result<PollResult, GithubError>> {
  const startedAt = now();
  const startResult = await markPollStarted({ db, integration: INTEGRATION, now: startedAt });
  if (startResult.isErr()) return err(fromDatabaseError(startResult.error));

  const sinceClause = since ? ` updated:>${since.toISOString()}` : '';
  const octokit = createGithubClient({ token });
  const responseResult = await safeGithubCall({
    execute: () =>
      octokit.rest.search.issuesAndPullRequests({
        q: `${qualifier}${sinceClause}`,
        per_page: PER_PAGE,
        sort: 'updated',
        order: 'desc',
      }),
    endpoint: 'search.issuesAndPullRequests',
  });
  if (responseResult.isErr()) return err(responseResult.error);
  const { data } = responseResult.value;

  const items = data.items ?? [];
  const observedAt = now();

  for (const item of items) {
    const upsertResult = await upsertEvidence({
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
    if (upsertResult.isErr()) return err(fromDatabaseError(upsertResult.error));
  }

  // When the poll returns zero items, preserve the prior watermark (`since`)
  // instead of resetting the cursor to null — otherwise the next poll would
  // backfill from the beginning unnecessarily.
  const newCursor = items[0]?.updated_at ?? since?.toISOString() ?? null;
  const completedResult = await markPollCompleted({
    db,
    integration: INTEGRATION,
    cursor: newCursor,
    now: observedAt,
  });
  if (completedResult.isErr()) return err(fromDatabaseError(completedResult.error));

  return ok({ fetched: items.length, newCursor });
}

function externalIdFor({ item, kind }: { item: SearchItem; kind: string }): string {
  const prefix = kind === 'pull_request' ? 'pr' : kind === 'issue' ? 'issue' : 'mention';
  return `${prefix}_${item.id}`;
}
