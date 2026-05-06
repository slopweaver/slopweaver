# @slopweaver/integrations-slack

Slack polling for SlopWeaver. Writes mentions and DMs into `evidence_log` and the auth'd bot identity into `identity_graph`. No write paths, no OAuth flow, no threads, no Socket Mode — those are out of scope for v1.

## API

Built on the official `@slack/web-api` SDK; we ship a thin factory plus three poll functions on top of `WebClient`.

- `createSlackClient({ token, retryConfig? })` — returns a configured `WebClient`. Defaults to `{ retries: 0 }` under `NODE_ENV=test` and an exponential backoff (`retries: 3, factor: 2, minTimeout: 1s, maxTimeout: 30s`) otherwise. Override via `retryConfig`.
- `pollMentions({ db, token, since?, client? })` — `auth.test` + `search.messages` for `<@U…>`; upserts into `evidence_log` with `kind='mention'`. Note: Slack's `search.messages` requires a user token (`xoxp-`) — bot tokens (`xoxb-`) get `not_allowed_token_type`.
- `pollDMs({ db, token, since?, client? })` — `auth.test` + `conversations.list?types=im` + `conversations.history` per channel; upserts with `kind='message'`.
- `fetchIdentity({ db, token, client? })` — `auth.test` + `users.info`. Writes one row to `identity_graph` for the auth'd user; preserves `canonical_id` and `created_at_ms` on subsequent calls.

All three poll functions accept an optional pre-built `WebClient` via `client` for composition / test injection. The package re-exports nothing about Slack's wire shapes — consumers reach for `@slack/web-api`'s own response types (`AuthTestResponse`, `UsersInfoResponse`, etc.) directly.

## Tests + cassettes

The current scaffold tests inject a `WebClient` partial mock for hermetic CI. Polly + `@pollyjs/adapter-node-http` is wired in `src/test/setup-polly.ts` ready for end-to-end recording against a real workspace; `@slack/web-api` routes through Node's `http` module after the test setup replaces native `fetch` with `node-fetch`, so cassettes capture real SDK traffic when `POLLY_MODE=record`.

Recordings live under `src/__recordings__/`. Auth headers (`authorization`, `cookie`) and any `token` / `secret` JSON fields are scrubbed before the cassette is written to disk.

> **Note**: the repo's root `.gitignore` excludes `*.har` as a safety net against accidentally committing real auth headers. When the first cassettes are recorded, decide whether to commit them (and add a `!` exception under `__recordings__/`) or keep cassettes per-developer and require re-recording locally.

```bash
# Replay (default, hermetic, what CI runs):
pnpm --filter @slopweaver/integrations-slack test

# Re-record against a real workspace (overwrites existing cassettes):
# Use a user token (xoxp-) — search.messages rejects bot tokens with not_allowed_token_type.
POLLY_MODE=record SLACK_USER_TOKEN=xoxp-… pnpm --filter @slopweaver/integrations-slack test
```

The patched `@pollyjs/adapter-node-http@6.0.6` (see `patches/`) fixes HTTPS request handling and content-encoding edge cases; nock is pinned to `13.5.6` for compatibility with that adapter.

## Development

```bash
pnpm --filter @slopweaver/integrations-slack compile
pnpm --filter @slopweaver/integrations-slack test
```
