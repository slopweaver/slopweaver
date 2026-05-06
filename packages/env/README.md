# @slopweaver/env

## Purpose

Single source of truth for the SlopWeaver binary's environment variable
contract. Defines a Zod schema and a `loadEnv()` helper that parses,
freezes, and returns the result. On invalid input, throws one
`EnvValidationError` with the full list of issues — never fail-fast on
the first.

## API

- `EnvSchema` — Zod schema covering `XDG_DATA_HOME` (optional non-empty
  string), `NODE_ENV` (`'development' | 'production' | 'test'`, default
  `'production'`), and `LOG_LEVEL` (`'debug' | 'info' | 'warn' | 'error'`,
  default `'info'`).
- `loadEnv({ env = process.env })` — parses and returns a frozen `Env`.
  Throws `EnvValidationError` (with `.issues: ReadonlyArray<EnvIssue>`)
  on failure.
- `Env`, `NodeEnv`, `LogLevel`, `EnvIssue` — inferred and helper types.

## Usage

```ts
import { loadEnv } from '@slopweaver/env';

// At the top of an app entrypoint:
const env = loadEnv();
// env.NODE_ENV, env.LOG_LEVEL, env.XDG_DATA_HOME — all validated and frozen.
```

`packages/db/src/path.ts` continues to read `process.env.XDG_DATA_HOME`
directly for its testable resolver fallback. The "no `process.env`
outside `@slopweaver/env`" rule applies to apps, not packages.
