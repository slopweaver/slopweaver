# @slopweaver/mcp-local

The SlopWeaver local MCP binary. Wires `@slopweaver/db` and
`@slopweaver/mcp-server` together and exposes the `slopweaver` command, which
runs an MCP server over stdio.

## Install (end users)

```bash
claude mcp add slopweaver -- npx -y @slopweaver/mcp-local
```

For Cursor, Cline, and Codex CLI configs, see the
[root README](../../README.md).

## What ships

- `dist/cli.js` — bundled, single-file ESM entry with a `#!/usr/bin/env node`
  shebang. Built by `build.mjs` (esbuild). The `bin: { slopweaver }` field
  points at this file.
- `migrations/` — copy of `packages/db/migrations/`, placed alongside `dist/`
  so `migrate(db, { migrationsFolder })` resolves correctly under the
  bundled `import.meta.url`.
- `better-sqlite3` is the only runtime `dependencies` entry: it ships native
  bindings that can't be bundled, so esbuild marks it `external` and Node's
  resolver picks it up at runtime.

## Local development

```bash
pnpm --filter @slopweaver/mcp-local compile   # tsc --noEmit type-check
pnpm --filter @slopweaver/mcp-local build     # esbuild bundle + chmod
pnpm --filter @slopweaver/mcp-local test      # build then smoke test
```

The smoke test in `src/cli.smoke.test.ts` spawns the built `dist/cli.js`,
points its data dir at a per-test tmp directory via `XDG_DATA_HOME`, sends
an MCP `tools/list` over stdio, and asserts `ping` is advertised. CI runs
this via `pnpm test`.

## Scope

In: stdio MCP server, `ping` tool, `--version` / `--help`. Out: `init`,
`doctor`, `connect` subcommands, the localhost web UI, real integrations.
Those land in follow-up issues.
