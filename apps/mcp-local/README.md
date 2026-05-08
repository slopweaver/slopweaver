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
  `better-sqlite3` + the Drizzle migrations folder), `@slopweaver/mcp-server`,
  and `@slopweaver/ui` (whose `dist/client/` static assets the binary
  serves on `127.0.0.1:60701`).
- No bundler. No dist/ commit. `tsc` is the only build step for this package
  (`@slopweaver/ui` itself uses Vite for its client bundle).

## Diagnostics web UI

By default, alongside the stdio MCP server, the binary starts a tiny HTTP
server on `127.0.0.1:60701` that serves the `@slopweaver/ui` Diagnostics
page plus a `GET /api/diagnostics` JSON endpoint. The bind is loopback-only;
`Origin` validation rejects cross-origin requests.

- `--no-web-ui` — suppress the web UI; useful when running multiple slopweaver
  instances from one machine.
- `SLOPWEAVER_WEB_UI_PORT` — override the port (set `0` to pick an ephemeral
  port; the bound URL is logged to stderr).
- If port 60701 is already in use, the binary logs a warning and continues
  with stdio only — non-fatal.

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

In: stdio MCP server, `ping` tool, `--version` / `--help` / `--no-web-ui`,
the local Diagnostics web UI on `127.0.0.1:60701`. Out: `init`, `doctor`,
`connect` subcommands, real integrations. Those land in follow-up issues.
