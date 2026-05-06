/**
 * Thin factory around `@octokit/rest` with the official throttling plugin
 * wired. Mirrors the slopweaver-private SaaS repo's pattern of treating
 * Octokit as a dumb REST wrapper, with two changes for the public OSS repo:
 *
 *   1. We don't have a separate Redis-backed `OutboundRateLimiterService` to
 *      delegate retries to, so `@octokit/plugin-throttling` handles primary +
 *      secondary rate-limit retries SDK-side (capped at MAX_RETRIES).
 *   2. We pass `request: { fetch: globalThis.fetch }` explicitly so Octokit
 *      always reads the test setup's swapped-in `node-fetch`, which routes
 *      through `node:http` where Polly's adapter intercepts.
 *
 * Errors thrown by Octokit are real `RequestError` instances from
 * `@octokit/request-error` — callers should `instanceof RequestError` and
 * read `.status` / `.response?.data` directly. We deliberately do not ship
 * a wrapper around that.
 */

import { throttling } from '@octokit/plugin-throttling';
import { Octokit } from '@octokit/rest';

const DEFAULT_USER_AGENT = 'slopweaver/0.0.0';
const MAX_RETRIES = 2;

export type CreateGithubClientArgs = {
  token: string;
  userAgent?: string;
};

/**
 * The factory's return type is just `Octokit`. We deliberately avoid
 * `Octokit.plugin(throttling)` at module level — the resulting class type
 * names types from internal Octokit packages that TS can't serialize into
 * our emitted `.d.ts` (TS2883). Constructing inline keeps the declared
 * return type to `Octokit`, which is portable.
 */
export type GithubClient = Octokit;

export function createGithubClient({
  token,
  userAgent = DEFAULT_USER_AGENT,
}: CreateGithubClientArgs): GithubClient {
  const ThrottledOctokit = Octokit.plugin(throttling);
  return new ThrottledOctokit({
    auth: token,
    userAgent,
    request: { fetch: globalThis.fetch },
    throttle: {
      onRateLimit: (_retryAfter, _options, _octokit, retryCount) => {
        return retryCount <= MAX_RETRIES;
      },
      onSecondaryRateLimit: (_retryAfter, _options, _octokit, retryCount) => {
        return retryCount <= MAX_RETRIES;
      },
    },
  });
}
