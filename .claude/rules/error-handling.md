# Error handling

How errors flow through SlopWeaver's TypeScript code.

This is the public-repo companion to the equivalent pattern in
`slopweaver-private`. The motivation: every error becomes part of a typed
union, so callers handle failure modes exhaustively (`.match()`,
`switch`) instead of relying on `try/catch` review hygiene. Decision
record: [#41](https://github.com/slopweaver/slopweaver/issues/41).

## The pattern in one minute

1. **Functions that can fail return `Result<T, E>` or `ResultAsync<T, E>`** from
   [`@slopweaver/errors`](../../packages/errors/README.md), where `E` is a
   discriminated union of error interfaces extending `BaseError`.
2. **External SDK / API calls go through `safeApiCall`** (in
   `@slopweaver/errors`). It's the only place exceptions from external
   calls become Results.
3. **Database operations go through `safeQuery`** (in `@slopweaver/db`).
   Same idea, scoped to better-sqlite3.
4. **At the user-facing boundary (CLI commands, MCP tool dispatch),
   `.match()` the Result** to print + exit, or to format an MCP error
   response.

That's it. The rest of this doc is the conventions that make those four
rules consistent across packages.

## Error type shape

Every domain error interface extends `BaseError`. The `code` field is
the discriminant, in `SCREAMING_SNAKE_CASE`. Codes are unique within a
package's error union.

```ts
import type { BaseError } from '@slopweaver/errors';

export interface SlackTokenInvalidError extends BaseError {
  readonly code: 'SLACK_TOKEN_INVALID';
  readonly tokenPrefix: string;
}

export interface SlackPaginationCapError extends BaseError {
  readonly code: 'SLACK_PAGINATION_CAP_EXCEEDED';
  readonly totalPages: number;
  readonly maxPages: number;
}

export type SlackError = SlackTokenInvalidError | SlackPaginationCapError; // | …
```

Each package exports both the union type AND a factory namespace, so
constructing errors is uniform:

```ts
export const SlackErrors = {
  tokenInvalid: (tokenPrefix: string): SlackTokenInvalidError => ({
    code: 'SLACK_TOKEN_INVALID',
    message: `Slack token must start with xoxp- or xoxb-, got "${tokenPrefix}"`,
    tokenPrefix,
  }),
  paginationCapExceeded: (totalPages: number, maxPages: number): SlackPaginationCapError => ({
    code: 'SLACK_PAGINATION_CAP_EXCEEDED',
    message: `Slack search returned ${totalPages} pages, exceeds MAX_PAGES=${maxPages}; cursor not advanced.`,
    totalPages,
    maxPages,
  }),
} as const;
```

Callers always go through factories — they never construct error
literals inline. This keeps messages consistent and gives you one place
to add fields later.

## Service layer: no throws

A "service" here is any function that performs side effects (network,
DB, FS) on behalf of the caller. Service files do not throw. They
return `Result` / `ResultAsync`.

```ts
// ✅ good
export function pollMentions(args: PollMentionsArgs): ResultAsync<PollResult, SlackError | DatabaseError> {
  // …
}

// ❌ bad — throws across a service boundary
export async function pollMentions(args: PollMentionsArgs): Promise<PollResult> {
  if (totalPages > MAX_PAGES) throw new Error(`pollMentions: …`);
}
```

Enforced by `pnpm check:neverthrow-service-boundaries` (custom CLI
check) for these globs:

- `packages/integrations/{core,github,slack}/src/!(test/**)*.ts`
- `packages/mcp-server/src/tools/**/*.ts`
- `packages/cli-tools/src/orchestration/{core,runtime}.ts`
- `apps/mcp-local/src/connect/*.ts`

Plus `eslint-plugin-neverthrow`'s `must-use-result` rule, which flags
unconsumed `Result` values anywhere in the tree.

## Legitimate recovery catches

The "no throws at service boundaries" rule is **not** "no `try/catch`
anywhere." Catches that locally downgrade or recover from a fault are
legitimate and stay. Examples currently in the tree:

- `packages/mcp-server/src/tools/composite/start-session.ts:275` —
  per-platform poll failures get logged and the overall session
  proceeds.
- `packages/ui/src/server/start.ts:152` — static-asset request handler
  catches per-request errors so one bad request doesn't kill the
  server.

The CLI check's allowlist names these explicitly. If you need a new
recovery catch, add a comment on the `try` line explaining why, and
either keep it inside an allowlisted file or extend the allowlist.

## Boundary translation back to throws

Errors are unwrapped only at the user-facing edge.

**CLI entrypoints** (`apps/mcp-local/src/cli.ts`,
`packages/cli-tools/src/cli.ts`) `.match()` the top-level result:

```ts
const result = await runCommand(args);
result.match(
  (success) => { stdout.write(format(success)); },
  (error) => { stderr.write(formatError(error) + '\n'); exit(1); },
);
```

**MCP tool handlers** (`packages/mcp-server/src/tools/...`) use a
boundary helper inside the dispatcher to convert `Err` into an
`isError: true`-style structured response. Don't widen every tool's
output schema to a success/error union — the dispatcher does the
translation in one place.

## External calls

For any SDK / HTTP call, use `safeApiCall` from `@slopweaver/errors`:

```ts
import { safeApiCall } from '@slopweaver/errors';
import { RequestError } from '@octokit/request-error';

const result = await safeApiCall({
  execute: () => octokit.rest.users.getAuthenticated(),
  provider: 'github',
  extractError: ({ error }) =>
    error instanceof RequestError ? { status: error.status, code: 'GITHUB_API_ERROR' } : {},
});
```

For database calls, use `safeQuery` from `@slopweaver/db`. Same shape,
sqlite-aware extractor.

If the raw `ApiCallError` / `DatabaseError` shape isn't right for your
domain, `.mapErr()` to a domain error:

```ts
return safeApiCall({ execute, provider: 'slack' }).mapErr((apiErr) =>
  apiErr.code === 'not_allowed_token_type'
    ? SlackErrors.tokenInvalid(token.slice(0, 4))
    : SlackErrors.upstreamFailure(apiErr.message),
);
```

## Test discipline

Use strong assertions on `Result` values:

```ts
// ✅ good
expect(result.isErr()).toBe(true);
if (result.isErr()) {
  expect(result.error.code).toBe('SLACK_TOKEN_INVALID');
}

// ❌ bad — .toBeTruthy() passes for any non-falsy value, hiding real bugs
expect(result.isErr()).toBeTruthy();
```

Tests for unhappy paths assert on `error.code` (the discriminant), not
`error.message` (the human-readable string is allowed to drift).

## Why these conventions

- **Code, not `_tag`.** Mirrors `slopweaver-private`'s convention so
  patterns travel cleanly between repos.
- **Factories, not inline literals.** One place to change a message; one
  place to add a field; nothing to grep for.
- **Boundary wrappers (`safeApiCall`/`safeQuery`), not ad-hoc `try/catch`.**
  The classification logic (extracting status codes, sqlite error names,
  vendor error envelopes) lives in one place per surface.
- **No throws at service boundaries.** Forces callers to acknowledge
  failure modes in the type system; review burden moves from "did I
  catch?" to "did I handle every code in the union?".

If a rule above conflicts with what a piece of code is trying to do,
file a `decision-record` issue rather than working around it.
