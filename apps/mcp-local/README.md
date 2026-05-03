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

- `dist/cli.js` — single-file ESM entry compiled from `src/cli.ts` by `tsc`.
  The `#!/usr/bin/env node` shebang at the top of the source is preserved
  through emit; npm sets the executable bit on install via the `bin` field.
- Runtime deps: `@slopweaver/db` (which transitively pulls
  `better-sqlite3` + the Drizzle migrations folder) and
  `@slopweaver/mcp-server`.
- No bundler. No dist/ commit. `tsc` is the only build step.

## Local development

```bash
pnpm --filter @slopweaver/mcp-local compile   # tsc --noEmit type-check
pnpm --filter @slopweaver/mcp-local build     # tsc emit → dist/cli.js
pnpm --filter @slopweaver/mcp-local test      # builds, then runs smoke test
```

`pnpm test` at the repo root runs the same gate. Turbo's `test` task depends
on `build` so the smoke test always runs against fresh emit. The smoke test
in `src/cli.smoke.test.ts` spawns `node dist/cli.js`, points the data dir at
a per-test tmp directory via `XDG_DATA_HOME`, and asserts `ping` round-trips
over stdio.

## Scope

In: stdio MCP server, `ping` tool, `--version` / `--help`. Out: `init`,
`doctor`, `connect` subcommands, the localhost web UI, real integrations.
Those land in follow-up issues.
