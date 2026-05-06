# @slopweaver/integrations-github

GitHub polling integration for SlopWeaver. The first concrete writer for `evidence_log` and `identity_graph`.

## Public surface

| Export                                    | Purpose                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `pollPullRequests({ db, token, since })`  | Search PRs that involve the authenticated user; upsert into `evidence_log` (`kind='pull_request'`) |
| `pollIssues({ db, token, since })`        | Same shape, `kind='issue'`                                                                       |
| `pollMentions({ db, token, since })`      | Same shape, `kind='mention'` — search-level mentions of `@me`                                    |
| `fetchIdentity({ db, token })`            | Upsert the authenticated user into `identity_graph`                                              |
| `githubFetch({ token, path, … })`         | Low-level REST wrapper with `X-RateLimit-Remaining` handling                                     |

All functions take named-object params. Pollers update `integration_state` (`cursor`, `last_poll_started_at_ms`, `last_poll_completed_at_ms`).

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
GITHUB_PAT=<your real PAT, repo+read:user scopes> \
  POLLY_MODE=record \
  pnpm --filter @slopweaver/integrations-github test
```

Sensitive headers (`authorization`, `cookie`, `set-cookie`, `x-github-request-id`) and any body keys matching `/token|secret|authorization|password|api[-_]?key/i` are redacted automatically before the cassette is persisted. PAT-shaped strings (`ghp_…`, `gho_…`, etc.) in body text are also rewritten to `[REDACTED-PAT]`. Inspect the recordings before committing — `git grep gh[posu]_ packages/integrations/github/` should return nothing.

The root `.gitignore` blocks `*.har` globally and explicitly allows `packages/integrations/github/**/__recordings__/**/*.har`.
