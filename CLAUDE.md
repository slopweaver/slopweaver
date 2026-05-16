# CLAUDE.md

Instructions for Claude Code working in the SlopWeaver public repo.

## What is SlopWeaver

Open-source local-first MCP server that helps Claude Code answer "what should I work on next?" by searching across your work tools. Pre-alpha; v1.0.0 in development. See [README.md](README.md) and the [v1.0.0 roadmap tracking issue](https://github.com/slopweaver/slopweaver/issues/2).

## Codebase Overview

A Turborepo monorepo with one published binary app (`apps/mcp-local/` — the `slopweaver` CLI) and eight workspace packages: runtime (`mcp-server`, `ui`, `db`, `env`, `contracts`, `errors`), integration (`integrations/{core,github,slack}`), and maintainer (`cli-tools`). Stack is Node 22.12+, pnpm 10, TypeScript 6 strict, Biome (format + lint), ESLint (boundaries + no-restricted-imports), Vitest, Polly for cassettes, Drizzle ORM + better-sqlite3, MCP SDK 1.29, Zod 4, neverthrow (via `@slopweaver/errors`), React 19 + Vite 8 for the Diagnostics UI.

For the full architecture, module guide, data flow diagrams, conventions, and navigation guide, see [docs/CODEBASE_MAP.md](docs/CODEBASE_MAP.md). For agent-facing workflow rules, see @.claude/rules/workflow.md, @.claude/rules/pr-conventions.md, @.claude/rules/testing.md, @.claude/rules/typescript-patterns.md, and @.claude/rules/error-handling.md.

## Repo state (pre-alpha)

This repo is pre-alpha and v1.0.0 is in active development. The published binary (`slopweaver`) and the Diagnostics UI exist; live polling is implemented in `connect` and the integration packages but is not yet wired into the `start_session` composite tool (which currently serves cached evidence only). Don't assume code is here unless you've verified — see `docs/CODEBASE_MAP.md` for what is actually present.

## Stack (target shape for v1.0.0)

- **Node 22, pnpm 10, Turborepo** — monorepo with `apps/` + `packages/`
- **TypeScript strict mode** — no `any` in production code; named object params for any function with 1+ args
- **Drizzle ORM** with SQLite (better-sqlite3) for the local binary
- **MCP SDK** (`@modelcontextprotocol/sdk`) for the server
- **Vitest** for tests; Polly for HTTP recording in integration tests

## Where things live

- `apps/mcp-local/` — the published `slopweaver` binary (npm install -g slopweaver). Wires stdio MCP server + Diagnostics UI + `connect <github|slack>` subcommand. The v1 product.
- `packages/mcp-server/` — framework-agnostic MCP server, tool registry, dispatcher (Result → MCP wire response), stdio transport. Composite tools live in `src/tools/composite/` (e.g. `start-session.ts`); builtin tools in `src/tools/builtin/` (e.g. `ping.ts`).
- `packages/integrations/` — `core/` (shared `upsertEvidence` + Polly setup), `github/`, `slack/`. Each platform package owns its identity fetch + polling + `errors.ts` + cassette setup.
- `packages/db/`, `packages/contracts/`, `packages/env/`, `packages/errors/` — shared core packages. `@slopweaver/errors` is the one place to import `Result`/`ResultAsync` (direct `neverthrow` imports are linter-blocked).
- `packages/ui/` — React Diagnostics page (`src/client/`) + Node HTTP server (`src/server/`) on `localhost:60701`.
- `packages/cli-tools/` — maintainer CLI (`pnpm cli`): `worktree-new`, `doctor`, `check-service-boundaries`, `orchestration prepare/run`.

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
