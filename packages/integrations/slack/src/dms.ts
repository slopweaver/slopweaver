/**
 * Poll Slack DMs (IM channels) and upsert into `evidence_log`.
 *
 * Two-step: `conversations.list?types=im` to enumerate IM channels the auth'd
 * user/bot participates in, then `conversations.history` per channel. Both
 * endpoints are cursor-paginated, so we use the SDK's `paginate()` helper —
 * every page is iterated, no silent caps. `since` becomes the `oldest` cursor
 * on each `conversations.history` call (Slack expects unix seconds with
 * optional decimal microseconds).
 *
 * Each poll brackets its work with `markPollStarted` / `markPollCompleted` so
 * `freshness` consumers (`start_session`, the Diagnostics UI) can see when
 * Slack last ran. Cursor advances to the newest message ts observed across
 * all channels in the poll; preserves prior watermark on empty.
 */

import type {
  ConversationsHistoryResponse,
  ConversationsListResponse,
  WebClient,
} from '@slack/web-api';
import type { SlopweaverDatabase } from '@slopweaver/db';
import { markPollCompleted, markPollStarted } from '@slopweaver/integrations-core';
import { createSlackClient } from './client.ts';
import { pickNewestTs, upsertSlackMessage } from './upsert.ts';

const INTEGRATION = 'slack';

export type PollDMsArgs = {
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

export async function pollDMs({
  db,
  token,
  since,
  client,
  now = Date.now,
}: PollDMsArgs): Promise<PollResult> {
  const slack = client ?? createSlackClient({ token });
  const startedAt = now();
  const startResult = await markPollStarted({ db, integration: INTEGRATION, now: startedAt });
  if (startResult.isErr()) throw new Error(startResult.error.message);

  const auth = await slack.auth.test();
  // biome-ignore lint/style/noNonNullAssertion: SDK contract guarantees team_id on ok:true
  const teamId = auth.team_id!;
  const workspaceUrl = auth.url ?? null;

  const oldest = since ? toSlackTs({ date: since }) : undefined;

  let fetched = 0;
  let newestTs: string | null = null;

  const listIterable = slack.paginate('conversations.list', {
    types: 'im',
    limit: 200,
  }) as AsyncIterable<ConversationsListResponse>;

  for await (const listPage of listIterable) {
    for (const channel of listPage.channels ?? []) {
      if (channel.is_im === false || !channel.id) continue;
      const historyIterable = slack.paginate('conversations.history', {
        channel: channel.id,
        limit: 100,
        ...(oldest !== undefined && { oldest }),
      }) as AsyncIterable<ConversationsHistoryResponse>;

      for await (const historyPage of historyIterable) {
        const messages = historyPage.messages ?? [];
        fetched += messages.length;

        const observedAt = now();
        for (const message of messages) {
          const upsertResult = await upsertSlackMessage({
            db,
            message,
            kind: 'message',
            teamId,
            workspaceUrl,
            channelId: channel.id,
            now: observedAt,
          });
          if (upsertResult.isErr()) throw new Error(upsertResult.error.message);
        }

        const pageNewest = pickNewestTs(messages);
        if (pageNewest && (newestTs === null || compareTs(pageNewest, newestTs) > 0)) {
          newestTs = pageNewest;
        }
      }
    }
  }

  // Cursors are always ISO-8601 so the public `since?: Date` /
  // `newCursor: string | null` contract round-trips through `new Date(cursor)`.
  // Match github's polling.ts:106 stable-format rule.
  const newCursor = newestTs ? slackTsToIso(newestTs) : (since?.toISOString() ?? null);
  const completedResult = await markPollCompleted({
    db,
    integration: INTEGRATION,
    cursor: newCursor,
    now: now(),
  });
  if (completedResult.isErr()) throw new Error(completedResult.error.message);
  return { fetched, newCursor };
}

function compareTs(a: string, b: string): number {
  const aN = Number.parseFloat(a);
  const bN = Number.parseFloat(b);
  if (!Number.isFinite(aN) || !Number.isFinite(bN)) return a.localeCompare(b);
  return aN === bN ? 0 : aN > bN ? 1 : -1;
}

function toSlackTs({ date }: { date: Date }): string {
  const seconds = Math.floor(date.getTime() / 1_000);
  return `${seconds}.000000`;
}

function slackTsToIso(ts: string): string {
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) {
    throw new Error(`slackTsToIso: cannot parse ts ${ts}`);
  }
  return new Date(Math.round(seconds * 1_000)).toISOString();
}
