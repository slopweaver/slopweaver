/**
 * Adapter that wraps the github polling functions in the `StartSessionPoller`
 * contract that `createStartSessionTool` (in `@slopweaver/mcp-server`) expects.
 *
 * Factory captures the auth token + the pre-resolved username. The returned
 * closure reads the current cursor from `integration_state` and calls
 * `pollPullRequests` → `pollIssues` → `pollMentions` sequentially with that
 * cursor as `since`. Sub-polls run sequentially (not `Promise.all`) so they
 * share the same GitHub search rate-limit budget without bursting; freshness
 * order (PRs, then issues, then mentions) reflects v1 ranking weight.
 *
 * The `StartSessionPoller` contract is `Promise<void>` with no error channel,
 * so this is the boundary where Result becomes promise rejection — done via
 * neverthrow's `_unsafeUnwrap()` (it throws on `Err`, which the wrapping
 * `async` function turns into a rejected promise). `_unsafeUnwrap` is a
 * neverthrow API, not a literal `throw`, so the
 * `pnpm cli check-service-boundaries` scanner ignores it.
 *
 * `fetchIdentity` is the caller's responsibility — the username is passed in
 * so the factory itself is network-free.
 */

import type { StartSessionPoller } from '@slopweaver/mcp-server';
import { readCursor } from '@slopweaver/integrations-core';
import { pollIssues, pollMentions, pollPullRequests } from './polling.ts';

const INTEGRATION = 'github';

export type CreateGithubPollerArgs = {
  /** GitHub personal access token (or app-installation token) with `repo` + `read:user` scopes. */
  token: string;
  /** Authenticated user's login. GitHub's `mentions:` qualifier rejects `@me`, so callers pre-resolve it via `fetchIdentity`. */
  username: string;
};

/**
 * Build a `StartSessionPoller` that refreshes github evidence by chaining
 * `pollPullRequests` → `pollIssues` → `pollMentions`. On `Err` from any
 * sub-poll the returned promise rejects.
 */
export function createGithubPoller({
  token,
  username,
}: CreateGithubPollerArgs): StartSessionPoller {
  return async ({ db, now }) => {
    const nowFn = (): number => now;

    // Read the cursor *before each* sub-poll. The three sub-polls share the
    // `integration_state.cursor` row, so each call's `markPollCompleted`
    // overwrites it. Threading the latest cursor into the next sub-poll's
    // `since` means an empty result (e.g. zero new mentions today) preserves
    // the prior watermark via polling.ts's `items[0]?.updated_at ??
    // since?.toISOString() ?? null` fallback — without re-reading, an empty
    // tail-call clobbers the cursor written by earlier sub-polls.
    const sinceFor = async (): Promise<Date | null> => {
      const result = await readCursor({ db, integration: INTEGRATION });
      const cursor = result._unsafeUnwrap();
      return cursor ? new Date(cursor) : null;
    };

    (await pollPullRequests({ db, token, since: await sinceFor(), now: nowFn }))._unsafeUnwrap();
    (await pollIssues({ db, token, since: await sinceFor(), now: nowFn }))._unsafeUnwrap();
    (
      await pollMentions({ db, token, since: await sinceFor(), username, now: nowFn })
    )._unsafeUnwrap();
  };
}
