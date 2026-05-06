/**
 * Minimal `fetch` wrapper for the GitHub REST API.
 *
 * Reads `X-RateLimit-Remaining` / `X-RateLimit-Reset` and sleeps until reset
 * when remaining drops below `rateLimitThreshold` (default 10). The `sleep`
 * function is injectable so tests don't actually wait.
 *
 * Throws `GithubFetchError` on non-2xx responses; returns the parsed body,
 * status, and `Headers` on success. Callers narrow the body with their own
 * type assertions (see `polling.ts`, `identity.ts`).
 */

const GITHUB_API = 'https://api.github.com';
const DEFAULT_RATE_LIMIT_THRESHOLD = 10;
const DEFAULT_USER_AGENT = 'slopweaver/0.0.0';

export class GithubFetchError extends Error {
  public readonly status: number;
  public readonly responseBody: unknown;

  constructor({
    status,
    responseBody,
    message,
  }: {
    status: number;
    responseBody: unknown;
    message: string;
  }) {
    super(message);
    this.name = 'GithubFetchError';
    this.status = status;
    this.responseBody = responseBody;
  }
}

export type GithubFetchArgs = {
  token: string;
  path: string;
  search?: URLSearchParams;
  sleep?: (ms: number) => Promise<void>;
  rateLimitThreshold?: number;
  userAgent?: string;
};

export type GithubFetchResult = {
  status: number;
  body: unknown;
  headers: Headers;
};

export async function githubFetch({
  token,
  path,
  search,
  sleep = (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  rateLimitThreshold = DEFAULT_RATE_LIMIT_THRESHOLD,
  userAgent = DEFAULT_USER_AGENT,
}: GithubFetchArgs): Promise<GithubFetchResult> {
  const url = new URL(path, GITHUB_API);
  if (search) {
    for (const [k, v] of search) {
      url.searchParams.set(k, v);
    }
  }

  const response = await fetch(url, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': userAgent,
      'x-github-api-version': '2022-11-28',
    },
  });

  const remaining = Number(response.headers.get('x-ratelimit-remaining'));
  const resetEpochS = Number(response.headers.get('x-ratelimit-reset'));
  if (
    Number.isFinite(remaining) &&
    Number.isFinite(resetEpochS) &&
    remaining < rateLimitThreshold
  ) {
    const sleepMs = Math.max(0, resetEpochS * 1000 - Date.now());
    await sleep(sleepMs);
  }

  const body = (await response.json().catch(() => null)) as unknown;
  if (!response.ok) {
    throw new GithubFetchError({
      status: response.status,
      responseBody: body,
      message: `GitHub GET ${path} failed: ${response.status}`,
    });
  }
  return { status: response.status, body, headers: response.headers };
}
