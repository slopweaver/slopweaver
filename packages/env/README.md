# @slopweaver/env

## Purpose

Single source of truth for the SlopWeaver binary's environment variable
contract. Defines a Zod schema and a `loadEnv()` helper that parses,
freezes, and returns the result wrapped in a neverthrow `Result`. On
invalid input the `Err` carries one `EnvValidationError` with the full
list of issues — never fail-fast on the first.

## API

- `EnvSchema` — Zod schema covering `XDG_DATA_HOME` (optional non-empty
  string), `NODE_ENV` (`'development' | 'production' | 'test'`, default
  `'production'`), and `LOG_LEVEL` (`'debug' | 'info' | 'warn' | 'error'`,
  default `'info'`).
- `loadEnv({ env = process.env })` — returns
  `Result<Readonly<Env>, EnvValidationError>`. The `Err` value is an
  `EnvValidationError` instance with `.issues: ReadonlyArray<EnvIssue>`.
- `Env`, `NodeEnv`, `LogLevel`, `EnvIssue`, `EnvValidationError` —
  inferred and helper types.

## Usage

```ts
import { loadEnv } from '@slopweaver/env';

// At an app entrypoint, unwrap the Result at the user-facing boundary:
const result = loadEnv();
if (result.isErr()) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
const env = result.value;
// env.NODE_ENV, env.LOG_LEVEL, env.XDG_DATA_HOME — all validated and frozen.
```

`packages/db/src/path.ts` continues to read `process.env.XDG_DATA_HOME`
directly for its testable resolver fallback. The "no `process.env`
outside `@slopweaver/env`" rule applies to apps, not packages.
