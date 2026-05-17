/**
 * Adapter that wraps the slack polling functions in the `StartSessionPoller`
 * contract that `createStartSessionTool` (in `@slopweaver/mcp-server`) expects.
 *
 * Internally the adapter stays inside the neverthrow `Result` world: every
 * step (`readCursor` → `pollMentions` → `readCursor` → `pollDMs`) is a
 * `ResultAsync<…, SlackError>` chained with `.andThen`. The cursor is re-read
 * before each sub-poll so an empty tail-call preserves the prior watermark
 * via the pollers' `newestTs ?? since?.toISOString() ?? null` fallback.
 *
 * The `StartSessionPoller` contract is `Promise<void>` with no error channel
 * (a separate decision-record issue tracks the eventual refactor to
 * `ResultAsync`), so the chain terminates in a single bridge that
 * `Promise.reject(error)`s on `Err`. No `_unsafeUnwrap`, no literal `throw` —
 * mirrors the carve-out in `.claude/rules/error-handling.md` for boundaries
 * whose consumers can't accept `Result`.
 *
 * No pre-fetched identity argument — Slack's pollers call `auth.test()`
 * internally to resolve the auth'd `user_id`, so the factory is network-free.
 */

import type { SlopweaverDatabase } from '@slopweaver/db';
import type { ResultAsync } from '@slopweaver/errors';
import { readCursor, rejectBoundaryError } from '@slopweaver/integrations-core';
import type { StartSessionPoller } from '@slopweaver/mcp-server';
import { pollDMs } from './dms.ts';
import { fromDatabaseError, type SlackError } from './errors.ts';
import { pollMentions } from './mentions.ts';

const INTEGRATION = 'slack';

export type CreateSlackPollerArgs = {
  /** Slack user token (`xoxp-`). Bot tokens (`xoxb-`) are rejected by `search.messages`; see `pollMentions`. */
  token: string;
};

/**
 * Build a `StartSessionPoller` that refreshes slack evidence by chaining
 * `pollMentions` → `pollDMs`. The cursor is read fresh before each sub-poll.
 * The single `Promise.reject` at the end is the only boundary between the
 * typed `Result` world and the contract's `Promise<void>`.
 */
export function createSlackPoller({ token }: CreateSlackPollerArgs): StartSessionPoller {
  return async ({ db, now }) => {
    const nowFn = (): number => now;
    // `pollMentions` / `pollDMs` declare `since?: Date` with
    // `exactOptionalPropertyTypes`, so passing `since: undefined` is a
    // compile error. Spread `{ since }` only when there's a cursor; an empty
    // object otherwise.
    const sinceArg = ({ cursor }: { cursor: string | null }): { since: Date } | Record<string, never> =>
      cursor ? { since: new Date(cursor) } : {};

    const result = await readSlackCursor({ db })
      .andThen((cursor) => pollMentions({ db, token, ...sinceArg({ cursor }), now: nowFn }))
      .andThen(() => readSlackCursor({ db }))
      .andThen((cursor) => pollDMs({ db, token, ...sinceArg({ cursor }), now: nowFn }));

    if (result.isErr()) {
      return rejectBoundaryError({ error: result.error });
    }
  };
}

/**
 * Fresh `ResultAsync` reading the slack cursor row from `integration_state`.
 * The `readCursor` helper returns the raw `DatabaseError` union; `mapErr`
 * lifts it into `SlackDatabaseError` so the chain's error type stays
 * `SlackError` throughout.
 */
function readSlackCursor({ db }: { db: SlopweaverDatabase }): ResultAsync<string | null, SlackError> {
  return readCursor({ db, integration: INTEGRATION }).mapErr(fromDatabaseError);
}
