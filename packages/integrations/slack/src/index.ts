/**
 * @slopweaver/integrations-slack public entry.
 *
 * Polls Slack mentions and DMs into `evidence_log`, marks per-poll progress
 * in `integration_state`, and upserts the auth'd identity into
 * `identity_graph`. No write operations, no OAuth flow, no threads — see the
 * README for scope.
 *
 * Built on `@slack/web-api`'s `WebClient`. Consumers can pass an existing
 * `WebClient` via the `client` argument on each entrypoint, or rely on the
 * factory to construct one from a token.
 */

export { createSlackClient } from './client.ts';
export {
  fromDatabaseError,
  safeSlackCall,
  SlackErrors,
  type SlackApiError,
  type SlackDatabaseError,
  type SlackError,
  type SlackPaginationCapError,
  type SlackTokenInvalidError,
  type SlackTsParseError,
} from './errors.ts';
export { fetchIdentity, type FetchIdentityArgs, type FetchIdentityResult } from './identity.ts';
export {
  pollMentions,
  type PollMentionsArgs,
  type PollResult as PollMentionsResult,
  type AnySlackMessage,
} from './mentions.ts';
export { pollDMs, type PollDMsArgs, type PollResult as PollDMsResult } from './dms.ts';
export {
  upsertSlackMessage,
  pickNewestTs,
  type SlackMessageKind,
} from './upsert.ts';
