# @slopweaver/errors

## Purpose

Shared error types and exception-to-`Result` boundary wrappers built on
[neverthrow](https://github.com/supermacro/neverthrow). Every package in
the monorepo uses these primitives so error handling is uniform: services
return `Result<T, E>` / `ResultAsync<T, E>` instead of throwing.

## API

- `BaseError` — `{ code: string; message: string }`. Every domain error
  interface extends this; `code` is the discriminant.
- `ApiCallError` — raw output of `safeApiCall` before service-layer
  mapping. Carries `provider`, `message`, optional `status`, optional
  `code`, optional `cause`.
- `DatabaseError` — raw output of `safeQuery` (lives in
  `@slopweaver/db`) before service-layer mapping. Defined here so
  non-DB packages can include it in their error unions without
  depending on `@slopweaver/db`.
- `safeApiCall({ execute, provider, extractError? })` — wraps a
  `Promise<T>` (or sync value) in `ResultAsync<T, ApiCallError>`. Per-SDK
  `extractError` callback pulls structured fields (HTTP status, error
  code) from the raw exception.

The DB-side wrapper `safeQuery` lives in `@slopweaver/db` because the
better-sqlite3 dependency belongs there.

## Conventions

Error definitions follow the discriminated-union pattern with a `code`
discriminant in `SCREAMING_SNAKE_CASE`. Each package exposes both an
error union type and a factory namespace:

```ts
import type { BaseError } from '@slopweaver/errors';

export interface SlackTokenInvalidError extends BaseError {
  readonly code: 'SLACK_TOKEN_INVALID';
  readonly tokenPrefix: string;
}

export type SlackError = SlackTokenInvalidError | /* … */;

export const SlackErrors = {
  tokenInvalid: (tokenPrefix: string): SlackTokenInvalidError => ({
    code: 'SLACK_TOKEN_INVALID',
    message: `Slack token must start with xoxp- or xoxb-, got "${tokenPrefix}"`,
    tokenPrefix,
  }),
} as const;
```

See `.claude/rules/error-handling.md` for the full convention.

## Usage

External API call:

```ts
import { safeApiCall } from '@slopweaver/errors';

const result = safeApiCall({
  execute: () => octokit.rest.users.getAuthenticated(),
  provider: 'github',
  extractError: ({ error }) =>
    error instanceof RequestError ? { status: error.status, code: 'GITHUB_API_ERROR' } : {},
});

if (result.isErr()) {
  // result.error is an ApiCallError
}
```

Test discipline:

```ts
expect(result.isErr()).toBe(true); // never .toBeTruthy()
if (result.isErr()) {
  expect(result.error.code).toBe('SLACK_TOKEN_INVALID');
}
```

`eslint-plugin-neverthrow`'s `must-use-result` rule would enforce that every
`Result` / `ResultAsync` is consumed, but it's currently incompatible with
ESLint 10 and is deferred (#41). The CLI service-boundary scanner at
`packages/cli-tools/src/check-neverthrow-service-boundaries/` covers the
highest-risk regression class (no thrown errors at service boundaries) in
the meantime.
