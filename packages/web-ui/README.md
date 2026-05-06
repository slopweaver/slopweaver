# @slopweaver/web-ui

React UI and tiny HTTP server that powers the SlopWeaver local Diagnostics page on
`http://127.0.0.1:60701`.

The package emits two artifacts:

- `dist/client/` — a Vite-built React app (`index.html` + bundled JS/CSS).
- `dist/server/` — a Node entry that exposes `startWebUiServer({ db })` and the
  `CLIENT_ASSETS_DIR` constant so `apps/mcp-local` can serve the static assets
  alongside the `GET /api/diagnostics` JSON endpoint.

The server binds to `127.0.0.1` only and validates the `Origin` header on
`/api/*` routes for baseline DNS-rebinding protection.

## Scripts

- `pnpm --filter @slopweaver/web-ui build` — produce `dist/client` and `dist/server`.
- `pnpm --filter @slopweaver/web-ui compile` — `tsc --noEmit` over the whole tree.
- `pnpm --filter @slopweaver/web-ui test` — run vitest (jsdom for client, node for server).

## Why two outputs

The browser app uses `lib: ["DOM"]` and JSX; the Node entry must not pull DOM types
into `apps/mcp-local`. Splitting `tsconfig.build.json` (server-only emit) from the
broader `tsconfig.json` (whole-tree typecheck for the IDE and `tsc --noEmit`) keeps
the published `dist/server/` Node-clean.
