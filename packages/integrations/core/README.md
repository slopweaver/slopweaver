# @slopweaver/integrations-core

Shared building blocks for SlopWeaver integration packages.

## What's here

- **`upsertEvidence` / `markPollStarted` / `markPollCompleted` / `readCursor`** — write helpers for `evidence_log` and `integration_state`. Generic over `integration: string`. Every integration package's poll functions delegate to these.
- **`definePollySetup({ extraRedactors?, extraRequestRewriter? })`** (re-exported from `./test-setup/polly`) — the Polly + nock + node-fetch cassette plumbing. Each integration package's vitest setup file is a 5-line call into this factory; package-specific concerns (e.g. github's `/user` PII placeholders, slack's message-text scrubbing) plug in via `extraRedactors`.

The factory pattern keeps the integration packages free of HTTP-mocking ceremony while still letting them extend the redactor pipeline for platform-specific PII.

## Why this package exists

When `@slopweaver/integrations-github` (#33) and `@slopweaver/integrations-slack` (#31) shipped, both copied the upsert helpers and the 280-line setup-polly module. Two consumers is enough to justify extracting. Future integrations (linear, jira, notion, …) depend on the same surface.

## Out of scope (today)

- Domain-specific shapes that don't generalize — kind prefixing, permalink derivation, paginator strategy. Each platform ships its own.
- `WebClient` / `Octokit` factory wrappers — token + retry policy is per-platform.
- Cassette redaction *content* — only the redaction *machinery* lives here. Each platform ships its own scrubbers.
