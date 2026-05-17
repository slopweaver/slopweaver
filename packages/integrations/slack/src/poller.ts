/**
 * Adapter that wraps the slack polling functions in the `StartSessionPoller`
 * contract that `createStartSessionTool` (in `@slopweaver/mcp-server`) expects.
 *
 * Factory captures the auth token. The returned closure reads the current
 * cursor from `integration_state` and calls `pollMentions` → `pollDMs`
 * sequentially with that cursor as `since`. Sequential ordering (not
 * `Promise.all`) keeps the two pollers off Slack's tier-limited rate budget
 * concurrently, and mirrors v1 ranking weight (mentions outrank DMs).
 *
 * The `StartSessionPoller` contract is `Promise<void>` with no error channel,
 * so this is the boundary where Result becomes promise rejection — done via
 * neverthrow's `_unsafeUnwrap()` (it throws on `Err`, which the wrapping
 * `async` function turns into a rejected promise). `_unsafeUnwrap` is a
 * neverthrow API, not a literal `throw`, so the
 * `pnpm cli check-service-boundaries` scanner ignores it.
 *
 * No pre-fetched identity argument — Slack's pollers call `auth.test()`
 * internally to resolve the auth'd `user_id`, so the factory is network-free.
 */

import type { StartSessionPoller } from '@slopweaver/mcp-server';
import { readCursor } from '@slopweaver/integrations-core';
import { pollDMs } from './dms.ts';
import { pollMentions } from './mentions.ts';

const INTEGRATION = 'slack';

export type CreateSlackPollerArgs = {
  /** Slack user token (`xoxp-`). Bot tokens (`xoxb-`) are rejected by `search.messages`; see `pollMentions`. */
  token: string;
};

/**
 * Build a `StartSessionPoller` that refreshes slack evidence by chaining
 * `pollMentions` → `pollDMs`. On `Err` from either sub-poll the returned
 * promise rejects.
 */
export function createSlackPoller({ token }: CreateSlackPollerArgs): StartSessionPoller {
  return async ({ db, now }) => {
    const nowFn = (): number => now;

    // Read the cursor *before each* sub-poll. The two sub-polls share the
    // `integration_state.cursor` row, so each call's `markPollCompleted`
    // overwrites it. Threading the latest cursor into the next sub-poll's
    // `since` means an empty result preserves the prior watermark via the
    // pollers' `newestTs ?? since?.toISOString() ?? null` fallback — without
    // re-reading, an empty tail-call clobbers the cursor written by earlier
    // sub-polls.
    const sinceFor = async (): Promise<{ since: Date } | Record<string, never>> => {
      const result = await readCursor({ db, integration: INTEGRATION });
      const cursor = result._unsafeUnwrap();
      return cursor ? { since: new Date(cursor) } : {};
    };

    (await pollMentions({ db, token, ...(await sinceFor()), now: nowFn }))._unsafeUnwrap();
    (await pollDMs({ db, token, ...(await sinceFor()), now: nowFn }))._unsafeUnwrap();
  };
}
