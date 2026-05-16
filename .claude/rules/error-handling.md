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

## Error definition location

Every error interface extends `BaseError` and lives in one of two
places:

1. **Generic / shared errors → `@slopweaver/errors`:**
   - `BaseError` (the interface every error extends)
   - `ApiCallError` (raw output of `safeApiCall`)
   - `DatabaseError` (raw output of `safeQuery`)
   - Constructors and helpers re-exported from neverthrow: `ok`, `err`,
     `okAsync`, `errAsync`, `Result`, `ResultAsync`, `fromThrowable`

2. **Domain-specific errors → per-package `errors.ts`:**
   - Each package that can fail owns one `errors.ts`. Define the error
     interfaces, a factory namespace (e.g. `SlackErrors.tokenInvalid({…})`),
     and any domain-specific safe-call wrapper (`safeSlackCall`,
     `safeGithubCall`).
   - Examples:
     - `packages/integrations/slack/src/errors.ts` — 5 codes
     - `packages/integrations/github/src/errors.ts` — 2 codes
     - `packages/cli-tools/src/orchestration/errors.ts` — 12 codes

**Why:** Errors live with the domain that creates them. New packages
(e.g. a future Linear integration) define their errors locally without
touching shared infrastructure. The base shapes in `@slopweaver/errors`
keep the discriminant convention enforced across all of them.

**Lint enforcement:** `ok`, `err`, `okAsync`, `errAsync`, `Result`,
`ResultAsync`, `fromThrowable` may not be imported directly from
`neverthrow` — `eslint.config.js` redirects to `@slopweaver/errors`
(except inside `packages/errors/**`, where the re-export barrel lives).

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

Enforced by `pnpm cli check-service-boundaries` (custom CLI check, wired
into `pnpm validate` as the first gate). The scanner covers these
directories (all `.ts` files except tests, recordings, and `src/test/`):

- `packages/db/src/**`
- `packages/cli-tools/src/lib/**`
- `packages/integrations/{core,github,slack}/src/**`
- `packages/mcp-server/src/tools/**`
- `apps/mcp-local/src/connect/**`

Plus these explicit single-file boundaries:

- `packages/cli-tools/src/orchestration/{core,runtime}.ts`
- `packages/cli-tools/src/worktree/index.ts`
- `packages/env/src/index.ts`
- `packages/mcp-server/src/server.ts`

See the "Carve-outs (throws that are allowed)" and
"eslint-plugin-neverthrow status" sections below for what's
intentionally *not* covered.

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

The scanner doesn't flag these because it only inspects `throw`
statements, not catches — a `try/catch` that swallows or maps an error
without re-throwing is invisible to it. If you need a new recovery
catch, add a comment on the `try` line explaining why the local recovery
is correct (so reviewers know it's intentional, not an oversight). If
you find yourself wanting to *re-throw* from a service-boundary file,
return a typed `Result` with a classification field instead.

## Boundary translation back to throws

Errors are unwrapped only at the user-facing edge.

**CLI entrypoints** (`apps/mcp-local/src/cli.ts`,
`packages/cli-tools/src/cli.ts`) translate the Result to a process exit
code at the top of each command action. Either `.match()`:

```ts
const result = await runCommand(args);
result.match(
  (success) => { stdout.write(format(success)); },
  (error) => { stderr.write(formatError(error) + '\n'); exit(1); },
);
```

…or — and this is what current CLI entrypoints actually use — the
equivalent `if (isErr)` early-return shape:

```ts
const result = await runCommand(args);
if (result.isErr()) {
  stderr.write(formatError(result.error) + '\n');
  exit(1);
  return;
}
stdout.write(format(result.value));
```

Either form is fine — pick whichever reads cleanly at the call site.
The CLI's outer `.catch()` (e.g. cac's `.action()` callback catching
from a thrown `EnvValidationError`) also serves as a backstop for the
typed-throw carve-out below; the `asMessage()` helper at the boundary
extracts `.message` from BaseError-shaped values so they print cleanly
either way.

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

## Carve-outs (throws that are allowed)

The "no throws at service boundaries" rule has three intentional
exemptions. Code in any of these places may throw without being a bug:

- **Browser-side data fetchers** (`packages/ui/src/client/api/**`) — React
  consumers catch via `<ErrorBoundary>`, React Query's `onError`, or
  SWR's `error` field; all three expect throw-based async. Threading
  `Result` into the JSX layer would buy nothing and force every render
  site to `.match()`. The scanner does not cover `packages/ui/src`.

- **CLI entry points** (`apps/*/src/cli.ts`, `packages/cli-tools/src/cli.ts`)
  — these are the boundary where Result is unwrapped via `.match()` and
  printed. The preferred shape is still `.match()` (or `if (result.isErr())
  { console.error(…); process.exit(…) }`), but throws are tolerated when:
  - The throw is from a synchronous parse helper that the caller of the
    parse helper wraps in a single `try/catch` (e.g. `cac.parse()`-style).
  - The throw value is itself a typed error already (e.g. `throw envResult.error`
    where the catcher checks `instanceof EnvValidationError`) — the CLI
    boundary's `asMessage()` helper extracts `.message` from BaseError-shaped
    objects so this prints cleanly.

- **Recovery / classification `try/catch` blocks** — `try/catch` that
  exists to *classify* an outcome (e.g. swallowing a known recoverable
  error so the broader operation can proceed) is fine. The scanner only
  flags `throw` statements, so a catch that doesn't re-throw isn't
  affected. If a catch *does* re-throw, prefer returning `Result` with
  a typed classification.

## eslint-plugin-neverthrow status

The upstream `eslint-plugin-neverthrow` runtime `must-use-result` rule
(which would flag forgotten Result unwraps like `if (result)` /
`result && x` / awaited-but-not-matched `ResultAsync`) is **not enabled**
in `eslint.config.js`. v1.1.4 (last published 2022) reads
`context.parserServices`, which moved to `context.sourceCode.parserServices`
in ESLint 9+; the plugin is therefore incompatible with the ESLint 10
this repo uses. Tracked in #41.

Until upstream catches up or a custom rule is written, the
`pnpm cli check-service-boundaries` scanner is the runtime enforcement —
it catches new throws at service boundaries, which is the highest-risk
regression class.
