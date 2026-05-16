/**
 * Poll Slack for messages mentioning the auth'd user; upsert into `evidence_log`.
 *
 * Strategy: `auth.test` to discover the auth'd user_id, then `search.messages`
 * with the query `<@U…>`. `search.messages` is page-based (not cursor-based),
 * so the SDK's `paginate()` does not apply — we walk pages manually using the
 * response's `messages.paging.{page, page_count}` until exhausted (or the
 * `MAX_PAGES` safety cap, currently 20 = ~2k mentions).
 *
 * Slack's `search.messages` historically requires a user token (`xoxp-`); bot
 * tokens get `not_allowed_token_type`. `safeSlackCall` lifts the SDK's
 * `WebAPIPlatformError` into a structured `SlackApiError` so callers can
 * branch on the slack code without inspecting the raw exception.
 *
 * `since` (when provided) becomes a `after:YYYY-MM-DD` modifier on the search
 * query. Slack search has no millisecond cursor and the `after:` operator's
 * timezone semantics are undocumented — we pad backward by 1 day so we never
 * miss boundary messages; the idempotent `(integration, kind_ts:channel)`
 * upsert dedupes the extra rows that pulls in.
 *
 * Returns `ResultAsync<PollResult, SlackError>`. When the safety cap fires the
 * function returns `err(SlackErrors.paginationCapExceeded(…))` without
 * advancing the cursor — `markPollCompleted` never runs, so the next poll
 * starts from the prior watermark and the unfetched tail is recoverable by
 * re-running with a tighter `since`.
 */

import type { WebClient } from '@slack/web-api';
import type { SlopweaverDatabase } from '@slopweaver/db';
import { err, errAsync, ok, type Result, ResultAsync } from '@slopweaver/errors';
import { markPollCompleted, markPollStarted } from '@slopweaver/integrations-core';
import { createSlackClient } from './client.ts';
import {
  fromDatabaseError,
  safeSlackCall,
  type SlackError,
  SlackErrors,
  type SlackTokenInvalidError,
  type SlackTsParseError,
} from './errors.ts';
import { type AnySlackMessage, pickNewestTs, upsertSlackMessage } from './upsert.ts';

const INTEGRATION = 'slack';
const PER_PAGE = 100;
const MAX_PAGES = 20;

export type PollMentionsArgs = {
  db: SlopweaverDatabase;
  token: string;
  since?: Date;
  client?: WebClient;
  now?: () => number;
};

export type PollResult = {
  fetched: number;
  newCursor: string | null;
};

export function pollMentions(args: PollMentionsArgs): ResultAsync<PollResult, SlackError> {
  return ResultAsync.fromSafePromise(pollMentionsInner(args)).andThen((r) => r);
}

async function pollMentionsInner({
  db,
  token,
  since,
  client,
  now = Date.now,
}: PollMentionsArgs): Promise<Result<PollResult, SlackError>> {
  const slackResult: Result<WebClient, SlackTokenInvalidError> = client
    ? ok(client)
    : createSlackClient({ token });
  if (slackResult.isErr()) return err(slackResult.error);
  const slack = slackResult.value;

  const startedAt = now();
  const startResult = await markPollStarted({ db, integration: INTEGRATION, now: startedAt });
  if (startResult.isErr()) return err(fromDatabaseError(startResult.error));

  const authResult = await safeSlackCall({
    execute: () => slack.auth.test(),
    endpoint: 'auth.test',
  });
  if (authResult.isErr()) return err(authResult.error);
  const auth = authResult.value;
  // biome-ignore lint/style/noNonNullAssertion: SDK contract guarantees user_id on ok:true
  const userId = auth.user_id!;
  // biome-ignore lint/style/noNonNullAssertion: SDK contract guarantees team_id on ok:true
  const teamId = auth.team_id!;
  const workspaceUrl = auth.url ?? null;

  const queryParts = [`<@${userId}>`];
  if (since) {
    const padded = new Date(since.getTime() - 24 * 60 * 60 * 1_000);
    queryParts.push(`after:${formatSlackDate({ date: padded })}`);
  }
  const query = queryParts.join(' ');

  let fetched = 0;
  let newestTs: string | null = null;
  let page = 1;
  let totalPages = 1;

  while (page <= MAX_PAGES) {
    const respResult = await safeSlackCall({
      execute: () => slack.search.messages({ query, count: PER_PAGE, page }),
      endpoint: 'search.messages',
    });
    if (respResult.isErr()) return err(respResult.error);
    const response = respResult.value;
    const matches = response.messages?.matches ?? [];
    fetched += matches.length;

    const observedAt = now();
    for (const match of matches) {
      const upsertResult = await upsertSlackMessage({
        db,
        message: match,
        kind: 'mention',
        teamId,
        workspaceUrl,
        now: observedAt,
      });
      if (upsertResult.isErr()) return err(upsertResult.error);
    }

    const pageNewest = pickNewestTs(matches);
    if (pageNewest && (newestTs === null || compareTs(pageNewest, newestTs) > 0)) {
      newestTs = pageNewest;
    }

    const paging = response.messages?.paging;
    totalPages = paging?.pages ?? page;
    if (!paging || page >= totalPages) break;
    page += 1;
  }

  // Refuse to advance the cursor if we exited the loop because of the safety
  // cap rather than because Slack said there were no more pages — otherwise
  // the unfetched tail is unrecoverable on the next poll. Returning Err is
  // loud enough that the operator sees it and can re-run with a tighter
  // `since`.
  if (totalPages > MAX_PAGES) {
    return err(SlackErrors.paginationCapExceeded(totalPages, MAX_PAGES));
  }

  // Preserve the prior watermark when the poll returns zero items, otherwise
  // the next poll would backfill from the beginning. Matches #33 github's
  // empty-page rule. Cursors are always ISO-8601 so the public
  // `since?: Date` / `newCursor: string | null` contract round-trips through
  // `new Date(cursor)` without per-platform parsing.
  let newCursor: string | null;
  if (newestTs) {
    const isoResult = slackTsToIso(newestTs);
    if (isoResult.isErr()) return err(isoResult.error);
    newCursor = isoResult.value;
  } else {
    newCursor = since?.toISOString() ?? null;
  }

  const completedResult = await markPollCompleted({
    db,
    integration: INTEGRATION,
    cursor: newCursor,
    now: now(),
  });
  if (completedResult.isErr()) return err(fromDatabaseError(completedResult.error));

  return ok({ fetched, newCursor });
}

function compareTs(a: string, b: string): number {
  const aN = Number.parseFloat(a);
  const bN = Number.parseFloat(b);
  if (!Number.isFinite(aN) || !Number.isFinite(bN)) return a.localeCompare(b);
  return aN === bN ? 0 : aN > bN ? 1 : -1;
}

function slackTsToIso(ts: string): Result<string, SlackTsParseError> {
  // Slack ts is "<unix-seconds>.<microseconds>". The `since?: Date` round-
  // trip only needs millisecond precision, so we floor to ms.
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) {
    return err(SlackErrors.tsParseFailed(ts));
  }
  return ok(new Date(Math.round(seconds * 1_000)).toISOString());
}

function formatSlackDate({ date }: { date: Date }): string {
  // Slack's `after:` modifier accepts YYYY-MM-DD; the date format is the
  // workspace timezone but our pad-by-1-day hedge handles the ambiguity.
  const yyyy = date.getUTCFullYear().toString().padStart(4, '0');
  const mm = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const dd = date.getUTCDate().toString().padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export type { AnySlackMessage };
