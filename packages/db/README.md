# @slopweaver/db

## Purpose

SQLite/Drizzle package for SlopWeaver local state. This package is consumed as
TypeScript source (`main: ./src/index.ts`) and has no build step.

## API

- `createDb({ path })` opens `better-sqlite3`, enables foreign keys, runs
  pending migrations, and returns `{ db, sqlite, close }`.
- `resolveDataDir()` and `resolveDbPath()` implement the XDG-aware default
  path rule: `$XDG_DATA_HOME/slopweaver/slopweaver.db` when `XDG_DATA_HOME` is
  set, otherwise `~/.slopweaver/slopweaver.db`. Per the XDG spec,
  `XDG_DATA_HOME` must be an absolute path; relative values are rejected
  with a thrown `Error` so misconfigured environments fail fast at startup.
- `src/schema/` exports the Drizzle table definitions.

## Development

```bash
pnpm --filter @slopweaver/db drizzle-kit generate
pnpm --filter @slopweaver/db test
pnpm --filter @slopweaver/db compile
```

Generated migrations live in `packages/db/migrations/` and are applied at
runtime by `createDb()`.

## Troubleshooting

`better-sqlite3` is a native module. Node 22 prebuilds work on Linux x64 (CI)
and macOS arm64; if install fails on a fresh dev machine, install Xcode CLT
(`xcode-select --install`) or python3 + build-essential.
