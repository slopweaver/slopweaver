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

After installing, the recommended first run is the interactive wizard:

```bash
npx -y @slopweaver/mcp-local init
```

It detects which MCP clients you have installed, offers to register
slopweaver in them, walks you through `connect github` and `connect slack`,
and verifies each token with a 10-second-timeboxed identity fetch.

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
the local Diagnostics web UI on `127.0.0.1:60701`, the `init` first-run
wizard, the `connect <integration>` subcommands, the `walk` subcommand
(read-only: prints the ranked `/lock-in` queue from
`.claude/personal/state/reconciliation.md`; the interactive TUI verb-loop
ships in a follow-up PR), and the `slack-send-image` subcommand
(human-acked Slack image send via the same 4-call web-API sequence the
Slack web client uses; requires a user `xoxc` token and a workspace URL;
the `.claude/commands/slack-image-draft.md` skill is the recommended
front end). Out: `doctor`. That ships in a follow-up issue.

## `slack-send-image` subcommand

```bash
slopweaver slack-send-image \
  --channel "C0123456789" \
  --text "deployment landed, p95 dropped from 4.9s to 667ms" \
  --image "/tmp/dd-after.png" \
  [--thread "1779326689.858299"]
```

Env vars:

- `SLACK_XOXC` (required if `--xoxc` is omitted): the user's xoxc token. Extract from a logged-in Slack browser tab. Tokens cycle on the order of 60-90 seconds on enterprise grid; re-extract immediately before each send.
- `SLOPWEAVER_SLACK_WORKSPACE_URL` (required if `--workspace-url` is omitted): the API base URL for the workspace, e.g. `https://acme.slack.com` or `https://acme.enterprise.slack.com`.
- `SLOPWEAVER_SLACK_ROUTE` (enterprise grid only): the `<enterprise_id>:<team_id>` route. Standard workspaces leave this unset.

The 4-call sequence runs `files.getUploadURL`, a binary POST of the image bytes, `files.completeUpload`, and `files.share`. Step 4 is the actual send (Slack has no draft-with-attachment path). The recommended flow is to draft the text via the Slack MCP for human review first, then run this command once the user acks. The `.claude/commands/slack-image-draft.md` skill drives that flow.
