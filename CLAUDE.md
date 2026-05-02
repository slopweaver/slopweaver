# CLAUDE.md

Instructions for Claude Code working in the SlopWeaver public repo.

## What is SlopWeaver

Open-source local-first MCP server that helps Claude Code answer "what should I work on next?" by searching across your work tools. Pre-alpha; v1.0.0 in development. See [README.md](README.md) and the [v1.0.0 roadmap tracking issue](https://github.com/slopweaver/slopweaver/issues/2).

## Repo state (pre-alpha)

This repo is in active scaffolding. Most packages and apps don't exist yet. Don't assume code is here unless you've verified.

Current files: `LICENSE`, `README.md`, `CLAUDE.md`, `SECURITY.md`, `.github/`, `.gitignore`. Everything else is upcoming.

## Stack (target shape for v1.0.0)

- **Node 22, pnpm 10, Turborepo** — monorepo with `apps/` + `packages/`
- **TypeScript strict mode** — no `any` in production code; named object params for any function with 1+ args
- **Drizzle ORM** with SQLite (better-sqlite3) for the local binary
- **MCP SDK** (`@modelcontextprotocol/sdk`) for the server
- **Vitest** for tests; Polly for HTTP recording in integration tests

## Where things live

- `apps/mcp-local/` — the local binary (npm install -g slopweaver). The v1 product.
- `packages/mcp-server/` — framework-agnostic MCP server, including composite tools in `src/tools/composite/`
- `packages/integrations/` — single package with subdirectories per platform (`github/`, `slack/`, etc.)
- `packages/db/`, `packages/auth/`, `packages/memory/`, `packages/contracts/` — shared core packages
- `packages/web-ui/` — React components for the local UI on `localhost:60701`

(See ARCHITECTURE.md when it exists for the full layout.)

## Development principles

- **Direct imports between packages.** No dependency-inversion abstractions until there's a real second implementation.
- **Composite MCP tools live in `packages/mcp-server/src/tools/composite/`.** Single-platform tools live in their integration package's `mcp-tools/` subdir.
- **Apps wire packages together. Packages don't import from apps.** Enforced by `eslint-plugin-boundaries`.
- **No `@nestjs/*` imports in `packages/*`.** NestJS belongs only to `apps/cloud/` (when that lands in v2). Enforced by `no-restricted-imports`.
- **Small, focused PRs with clear descriptions.** Each PR should be reviewable in one sitting and have a real "what + why + test plan."

## Security and privacy

- This repo is public. Never commit user data, API keys, OAuth secrets, or test fixtures containing real customer/employer information.
- The `.gitignore` excludes `.env` files, `*.har`, and other common secret carriers — but verify any test fixture you add doesn't contain real tokens.
- Vulnerabilities should be reported privately to admin@slopweaver.ai (see [SECURITY.md](SECURITY.md)).

## Strategy and design decisions

The full strategy / decision trail is internal and lives in a private repo. This public repo is the implementation. If you need design context that isn't in code or in this README, ask [@lachiejames](https://github.com/lachiejames) rather than inventing it.

## Issue and PR conventions

- File issues using the templates in `.github/ISSUE_TEMPLATE/` (when those land).
- PRs: use the template in `.github/pull_request_template.md` (when that lands).
- Squash-merge only. Auto-delete branch on merge.

## License

MIT. By contributing, you agree your contributions are licensed under MIT.
