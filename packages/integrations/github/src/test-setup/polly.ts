/**
 * Polly cassette setup for @slopweaver/integrations-github tests.
 *
 * Wires the shared cassette plumbing from @slopweaver/integrations-core. The
 * github-specific concerns are:
 *
 * 1. **Repo scoping in record mode** — narrow `/search/issues` queries to a
 *    public repo so even an over-scoped PAT can only return public data.
 *    No-op in replay (the matcher ignores query params).
 * 2. **`/user` PII redaction** — the GitHub `/user` endpoint returns the
 *    recording user's full profile (login, name, avatar, follower counts,
 *    creation date — every field a determined adversary could correlate).
 *    Substitute every field with stable placeholders before the cassette
 *    is persisted.
 */

import {
  definePollySetup,
  type PollyRecording,
} from '@slopweaver/integrations-core/test-setup/polly';

const RECORD_REPO_SCOPE = process.env['RECORD_REPO_SCOPE'] ?? 'slopweaver/slopweaver';

function maybeScopeGithubSearchUrl(urlString: string): string {
  const url = new URL(urlString);
  if (url.hostname !== 'api.github.com' || url.pathname !== '/search/issues') {
    return urlString;
  }
  const q = url.searchParams.get('q') ?? '';
  if (q.includes('repo:')) return urlString;
  url.searchParams.set('q', `${q} repo:${RECORD_REPO_SCOPE}`);
  return url.toString();
}

const USER_PLACEHOLDERS: Record<string, unknown> = {
  login: 'test-user',
  id: 1,
  node_id: 'U_test',
  avatar_url: 'https://avatars.githubusercontent.com/u/1?v=4',
  gravatar_id: '',
  url: 'https://api.github.com/users/test-user',
  html_url: 'https://github.com/test-user',
  followers_url: 'https://api.github.com/users/test-user/followers',
  following_url: 'https://api.github.com/users/test-user/following{/other_user}',
  gists_url: 'https://api.github.com/users/test-user/gists{/gist_id}',
  starred_url: 'https://api.github.com/users/test-user/starred{/owner}{/repo}',
  subscriptions_url: 'https://api.github.com/users/test-user/subscriptions',
  organizations_url: 'https://api.github.com/users/test-user/orgs',
  repos_url: 'https://api.github.com/users/test-user/repos',
  events_url: 'https://api.github.com/users/test-user/events{/privacy}',
  received_events_url: 'https://api.github.com/users/test-user/received_events',
  name: 'Test User',
  email: null,
  bio: null,
  company: null,
  blog: null,
  location: null,
  hireable: null,
  twitter_username: null,
  notification_email: null,
  public_repos: 0,
  public_gists: 0,
  followers: 0,
  following: 0,
  created_at: '2020-01-01T00:00:00Z',
  updated_at: '2020-01-01T00:00:00Z',
};

function redactGithubUserResponse(recording: PollyRecording): void {
  const requestUrl = recording.request?.url ?? '';
  const isUserEndpoint =
    requestUrl.includes('api.github.com/user') && !requestUrl.includes('api.github.com/users/');
  if (!isUserEndpoint) return;
  const text = recording.response?.content?.text;
  if (typeof text !== 'string') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
  const replaced: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  for (const [key, value] of Object.entries(USER_PLACEHOLDERS)) {
    if (key in replaced) {
      replaced[key] = value;
    }
  }
  if (recording.response?.content) {
    recording.response.content.text = JSON.stringify(replaced);
  }
}

definePollySetup({
  extraRedactors: [redactGithubUserResponse],
  extraRequestRewriter: maybeScopeGithubSearchUrl,
});
