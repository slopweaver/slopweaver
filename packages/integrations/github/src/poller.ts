/**
 * Adapter that wraps the github polling functions in the `StartSessionPoller`
 * contract that `createStartSessionTool` (in `@slopweaver/mcp-server`) expects.
 *
 * Internally the adapter stays inside the neverthrow `Result` world: every
 * step (`readCursor` → `pollPullRequests` → `readCursor` → `pollIssues` →
 * `readCursor` → `pollMentions`) is a `ResultAsync<…, GithubError>` chained
 * with `.andThen`. The cursor is re-read before each sub-poll so an empty
 * tail-call preserves the prior watermark via polling.ts's
 * `items[0]?.updated_at ?? since?.toISOString() ?? null` fallback.
 *
 * The `StartSessionPoller` contract is `Promise<void>` with no error channel
 * (a separate decision-record issue tracks the eventual refactor to
 * `ResultAsync`), so the chain terminates in a single `.match` that bridges
 * to a Promise rejection. No `_unsafeUnwrap`, no literal `throw` — the
 * `Promise.reject(error)` path mirrors the carve-out in
 * `.claude/rules/error-handling.md` for boundaries whose consumers can't
 * accept `Result` (the UI data-fetcher carve-out is the same shape).
 *
 * `fetchIdentity` is the caller's responsibility — the username is passed in
 * so the factory itself is network-free.
 */

import type { SlopweaverDatabase } from '@slopweaver/db';
import type { ResultAsync } from '@slopweaver/errors';
import { readCursor } from '@slopweaver/integrations-core';
import type { StartSessionPoller } from '@slopweaver/mcp-server';
import { fromDatabaseError, type GithubError } from './errors.ts';
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
 * `pollPullRequests` → `pollIssues` → `pollMentions`. The cursor is read
 * fresh before each sub-poll. The single `.match` at the end is the only
 * boundary between the typed `Result` world and the contract's
 * `Promise<void>`.
 */
export function createGithubPoller({
  token,
  username,
}: CreateGithubPollerArgs): StartSessionPoller {
  return async ({ db, now }) => {
    const nowFn = (): number => now;
    const since = ({ cursor }: { cursor: string | null }): Date | null =>
      cursor ? new Date(cursor) : null;

    const result = await readGithubCursor({ db })
      .andThen((cursor) => pollPullRequests({ db, token, since: since({ cursor }), now: nowFn }))
      .andThen(() => readGithubCursor({ db }))
      .andThen((cursor) => pollIssues({ db, token, since: since({ cursor }), now: nowFn }))
      .andThen(() => readGithubCursor({ db }))
      .andThen((cursor) =>
        pollMentions({ db, token, since: since({ cursor }), username, now: nowFn }),
      );

    if (result.isErr()) {
      // CLI-style boundary: the cron consumer expects a throw-based callback,
      // but per .claude/rules/error-handling.md, service files don't `throw`.
      // `return Promise.reject(...)` from an async function is the canonical
      // Result-aware translation — equivalent to `throw` semantically, but
      // keeps check-service-boundaries clean. The Oxlint rule that prefers
      // `throw` is disabled for this exact pattern.
      // oxlint-disable-next-line unicorn/no-useless-promise-resolve-reject -- service-boundary carve-out
      return Promise.reject(
        new Error(`${result.error.code}: ${result.error.message}`, { cause: result.error }),
      );
    }
  };
}

/**
 * Fresh `ResultAsync` reading the github cursor row from `integration_state`.
 * The `readCursor` helper returns the raw `DatabaseError` union; `mapErr`
 * lifts it into `GithubDatabaseError` so the chain's error type stays
 * `GithubError` throughout.
 */
function readGithubCursor({
  db,
}: {
  db: SlopweaverDatabase;
}): ResultAsync<string | null, GithubError> {
  return readCursor({ db, integration: INTEGRATION }).mapErr(fromDatabaseError);
}
