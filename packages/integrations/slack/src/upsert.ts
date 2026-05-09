/**
 * Slack-specific shim that translates a Slack message (from `search.messages`
 * or `conversations.history`) into the generic `UpsertEvidenceArgs` shape
 * `@slopweaver/integrations-core` exposes.
 *
 * `external_id` is kind-prefixed (`mention_…` / `message_…`) so the same
 * Slack `ts` observed via both `search.messages` (a mention) and
 * `conversations.history` (the DM that contains the mention) lands as two
 * rows in `evidence_log` — same wire-level convention #33's github package
 * uses for `pr_` / `issue_` / `mention_`.
 *
 * The function returns the message's `ts` on success so the caller can
 * compute a cursor for `markPollCompleted`. Returns `null` when the message
 * was skipped (missing `ts`, missing channel, or malformed `ts`).
 */

import type { ConversationsHistoryResponse, SearchMessagesResponse } from '@slack/web-api';
import type { SlopweaverDatabase } from '@slopweaver/db';
import { type DatabaseError, okAsync, type ResultAsync } from '@slopweaver/errors';
import { upsertEvidence } from '@slopweaver/integrations-core';

type SearchMatch = NonNullable<NonNullable<SearchMessagesResponse['messages']>['matches']>[number];
type HistoryMessage = NonNullable<ConversationsHistoryResponse['messages']>[number];
export type AnySlackMessage = SearchMatch | HistoryMessage;

export type SlackMessageKind = 'mention' | 'message';

export function upsertSlackMessage({
  db,
  message,
  kind,
  teamId,
  workspaceUrl,
  channelId,
  now,
}: {
  db: SlopweaverDatabase;
  message: AnySlackMessage;
  kind: SlackMessageKind;
  teamId: string;
  workspaceUrl: string | null;
  channelId?: string;
  now: number;
}): ResultAsync<{ ts: string | null }, DatabaseError> {
  const ts = message.ts;
  if (!ts) return okAsync({ ts: null });

  const resolvedChannelId = channelId ?? extractChannelId({ message });
  if (!resolvedChannelId) return okAsync({ ts: null });

  const occurredAtMs = parseSlackTs({ ts });
  if (occurredAtMs === null) return okAsync({ ts: null });

  const externalId = `${kind}_${ts}:${resolvedChannelId}`;
  const text = message.text ?? '';
  const title = text.length > 0 ? (text.split('\n', 1)[0]?.slice(0, 200) ?? null) : null;
  const permalinkFromMatch =
    'permalink' in message && typeof message.permalink === 'string' ? message.permalink : undefined;
  const citationUrl =
    permalinkFromMatch ?? buildPermalink({ workspaceUrl, channelId: resolvedChannelId, ts });

  return upsertEvidence({
    db,
    integration: 'slack',
    externalId,
    kind,
    title,
    body: text || null,
    citationUrl,
    payloadJson: JSON.stringify({ ...message, _team_id: teamId }),
    occurredAtMs,
    now,
  }).map(() => ({ ts }));
}

/**
 * Returns the lexicographically greatest `ts` from a list of messages, which
 * (because Slack `ts` is `<unix-seconds>.<microseconds>` zero-padded enough
 * to compare correctly as a string in any practical window) is the newest.
 * Returns `null` if no message has a `ts`.
 */
export function pickNewestTs(messages: AnySlackMessage[]): string | null {
  let newest: string | null = null;
  for (const message of messages) {
    const ts = message.ts;
    if (typeof ts !== 'string' || ts.length === 0) continue;
    if (newest === null || compareSlackTs(ts, newest) > 0) {
      newest = ts;
    }
  }
  return newest;
}

function compareSlackTs(a: string, b: string): number {
  const aN = Number.parseFloat(a);
  const bN = Number.parseFloat(b);
  if (!Number.isFinite(aN) || !Number.isFinite(bN)) return a.localeCompare(b);
  return aN === bN ? 0 : aN > bN ? 1 : -1;
}

function extractChannelId({ message }: { message: AnySlackMessage }): string | null {
  const channel = (message as SearchMatch).channel;
  if (!channel) return null;
  if (typeof channel === 'string') return channel;
  return channel.id ?? null;
}

function buildPermalink({
  workspaceUrl,
  channelId,
  ts,
}: {
  workspaceUrl: string | null;
  channelId: string;
  ts: string;
}): string | null {
  if (!workspaceUrl) return null;
  // Slack permalinks are `<workspace>/archives/<channel>/p<ts-without-dot>`.
  const tsCompact = ts.replace('.', '');
  const base = workspaceUrl.endsWith('/') ? workspaceUrl.slice(0, -1) : workspaceUrl;
  return `${base}/archives/${channelId}/p${tsCompact}`;
}

function parseSlackTs({ ts }: { ts: string }): number | null {
  // Slack ts is "<unix-seconds>.<microseconds>" — convert to epoch ms.
  // Returns null on malformed input so callers can skip the row instead of
  // coercing to epoch 0 and corrupting freshness ordering.
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return null;
  return Math.round(seconds * 1_000);
}
