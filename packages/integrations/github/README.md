# @slopweaver/integrations-github

GitHub polling integration for SlopWeaver. The first concrete writer for `evidence_log` and `identity_graph`.

## Public surface

| Export                                                | Purpose                                                                                                |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `pollPullRequests({ db, token, since })`              | Search PRs that involve the authenticated user; upsert into `evidence_log` (`kind='pull_request'`)     |
| `pollIssues({ db, token, since })`                    | Same shape, `kind='issue'`                                                                             |
| `pollMentions({ db, token, since, username })`        | Same shape, `kind='mention'`. Username is required because GitHub's `mentions:` qualifier rejects `@me` |
| `fetchIdentity({ db, token })`                        | Upsert the authenticated user into `identity_graph`                                                    |
| `createGithubClient({ token, userAgent? })`           | Octokit factory pre-wired with `@octokit/plugin-throttling` (caps retries at 2 for both primary + secondary rate limits) |

Errors thrown by Octokit calls are real `RequestError` instances from `@octokit/request-error`. Callers should narrow via `instanceof RequestError` and read `.status` / `.response?.data` directly — we deliberately don't ship a wrapper around that.

All functions take named-object params. Pollers update `integration_state` (`cursor`, `last_poll_started_at_ms`, `last_poll_completed_at_ms`).

## Dependencies

- **`@octokit/rest@22.0.1`** — official GitHub SDK. Pinned to match the slopweaver-private SaaS repo.
- **`@octokit/plugin-throttling@11.0.3`** — handles primary (`X-RateLimit-Remaining`) and secondary (search/abuse) rate limits with bounded retries. We don't yet have a separate Redis-backed rate-limiter service like private's `OutboundRateLimiterService`, so the SDK plugin owns this for now.

Response item types come straight from `RestEndpointMethodTypes` in `@octokit/rest` — we don't hand-roll wrappers.

## Out of scope (v1)

- OAuth / GitHub App installation
- Webhooks
- GraphQL endpoints
- Write operations (creating PRs, issues, comments)
- Comment-level mentions (use `/notifications` in a future package)
- Pagination beyond `per_page=50` (a follow-up issue once we hit volume)

## Tests + Polly

Tests use [`@pollyjs/core`](https://github.com/Netflix/pollyjs) with an HTTP-recording adapter, plus [`nock`](https://github.com/nock/nock) as a defense-in-depth net guard. Native `fetch` is replaced with `node-fetch` at test setup so Polly's `node-http` adapter can intercept; this is restored in `afterAll`.

The bundled patch (`patches/@pollyjs__adapter-node-http@6.0.6.patch` at the repo root) fixes HTTPS handling in the adapter — it's required.

### Replay (CI default)

```bash
pnpm --filter @slopweaver/integrations-github test
```

In replay mode, missing cassettes fail the test loudly with a `Missing Polly recording(s)` error. CI never makes live calls.

### Recording new cassettes

Cassettes live next to each test under `__recordings__/<suite>/<test>/recording.har`. To record:

```bash
GH_TOKEN=<your real PAT> \
  POLLY_MODE=record \
  pnpm --filter @slopweaver/integrations-github test
```

The PAT should be a fine-grained token scoped to **public repositories only** with **Issues (read)**, **Pull requests (read)**, and **Metadata (read)** repository permissions. No account permissions are required. The setup file also auto-loads `GH_TOKEN` from a `.env` file at the monorepo root if present.

Three layers of safety run in record mode:

1. **Search-query scoping.** All outgoing `/search/issues` requests get `repo:slopweaver/slopweaver` appended to their `q` parameter so the GitHub search index can only return data from one public repo. Override via `RECORD_REPO_SCOPE=other-owner/other-repo` if needed.
2. **`/user` response redaction.** The authenticated user's profile fields (`login`, `id`, `email`, `name`, `avatar_url`, `html_url`, `bio`, `company`, `location`, etc.) are substituted with stable placeholders (`test-user`, `id: 1`, `null`) before the cassette is persisted. Tests assert only on shape, so the placeholders satisfy every expectation.
3. **Header + token redaction.** `Authorization`, `Cookie`, `Set-Cookie`, and `X-GitHub-Request-Id` headers are stripped. PAT-shaped strings (`ghp_…`, `gho_…`, etc.) anywhere in body text are rewritten to `[REDACTED-PAT]`. Body keys matching `/token|secret|authorization|password|api[-_]?key/i` are replaced with `[REDACTED]`.

After recording, inspect the cassettes:

```bash
git grep -E 'gh[posu]_[A-Za-z0-9]{16,}' packages/integrations/github/   # tokens
git grep -i '<your-real-login>' packages/integrations/github/           # personal handles
```

Both should return nothing. The root `.gitignore` blocks `*.har` globally and explicitly allows `packages/integrations/github/**/__recordings__/**/*.har`.
