# @slopweaver/cli-tools

Developer CLI for working in the SlopWeaver monorepo.

Invoke from the workspace root:

```bash
pnpm cli <subcommand> [options]
```

Implementation: `tsx`-executed TypeScript source (no build step). Modern ESM.
[`cac`](https://github.com/cacjs/cac) for argument parsing,
[`@inquirer/prompts`](https://github.com/SBoudrias/Inquirer.js) for interactive
prompts, [`picocolors`](https://github.com/alexeyraspopov/picocolors) for color.
[`vitest`](https://vitest.dev) runs the unit tests.

## Subcommands

### `worktree-new <name>`

Creates a fresh git worktree from `origin/main`, one directory up from the
monorepo root, on a new branch `worktree/<name>`. Installs dependencies in
the new worktree by default.

```bash
pnpm cli worktree-new fix-issue-42
# creates ~/dev/worktrees/fix-issue-42 on branch worktree/fix-issue-42
# runs pnpm install in the new worktree

pnpm cli worktree-new quick-fix --no-install
# skip the pnpm install step
```

This is the recommended way to start work on an issue or feature so the
main checkout stays clean and you can run multiple parallel work streams.

### `doctor`

Checks that your local environment is ready for SlopWeaver development.

```bash
pnpm cli doctor
```

It runs four checks:

- **Node version** -- requires Node ≥ 22 (matches `.nvmrc`).
- **pnpm version** -- requires pnpm ≥ 10 (matches `packageManager` in root `package.json`).
- **Port 60701 free** -- the local API port; doctor fails if something is bound.
- **Data dir** -- `~/.slopweaver/`. If missing, doctor offers to create it interactively.

Example output (all checks green):

```
SlopWeaver doctor

✓ Node version  node 22.19.0 (>=22)
✓ pnpm version  pnpm 10.0.0 (>=10)
✓ Port 60701 free  port 60701 available
✓ Data dir  /Users/you/.slopweaver (writable)

All good. You are ready to develop.
```

Example output when the data dir is missing (interactive prompt fires):

```
SlopWeaver doctor

✓ Node version  node 22.19.0 (>=22)
✓ pnpm version  pnpm 10.0.0 (>=10)
✓ Port 60701 free  port 60701 available
! Data dir  /Users/you/.slopweaver (missing -- will offer to create)

? Create data dir at /Users/you/.slopweaver? (Y/n) y
✔ Create data dir at /Users/you/.slopweaver? Yes
✓ Data dir  /Users/you/.slopweaver (writable)

All good. You are ready to develop.
```

Exit code is 0 when everything is green or only warnings remain, 1 when any check fails.

### `orchestration <subcommand> <chainPath>`

Drives the maintainer's hybrid Codex + Claude workflow described in
[`.claude/commands/codex.md`](../../.claude/commands/codex.md). Two
subcommands:

- **`prepare`** — bootstraps the worktree + writes prompt artifacts under
  `$CODEX_HOME/orchestration-runs/<slug>/`. Designed to be consumed by a
  Claude-side launcher (maintainer-external). No codex calls during
  `prepare`.
- **`run`** — codex-only fallback runner. Executes every phase (plan,
  implement, review, CI fix) through `codex-agent` with no Claude in the
  loop. Use when Claude is rate-limited.

```bash
pnpm cli orchestration prepare @docs/orchestration/examples/refactor-example.md
pnpm cli orchestration run @docs/orchestration/examples/refactor-example.md --dry-run
pnpm cli orchestration run @docs/orchestration/examples/refactor-example.md
pnpm cli orchestration run @docs/orchestration/examples/refactor-example.md --restart
```

Flags: `--executor hybrid|codex-only` (prepare only — `run` is always
codex-only), `--dry-run` (run only), `--restart` (clears saved state),
`--notify` (run only — fires `cmux notify` at the manual-QA stop point).

`run` requires `codex-agent` on `PATH`. See
[Codex install (optional)](../../docs/contributing/ai-workflow.md#codex-install-optional)
in the contributor docs. Chain-file format:
[`docs/orchestration/chain-format.md`](../../docs/orchestration/chain-format.md).

`orchestration` uses a single top-level cac command with internal
subcommand routing (`<subcommand>` is a positional arg) because cac 7 does
not dispatch multi-word command names — see the convention note below.

## Adding a subcommand

1. Create `src/<subcommand>/index.ts` exporting a `run<Subcommand>(...)` function.
2. Put pure logic (parsing, validation, environment checks) in sibling files
   like `src/<subcommand>/checks.ts` so they're easy to unit-test.
3. Wire it up in `src/cli.ts` with a new `cli.command(...).action(...)` block.
4. Add colocated `*.test.ts` files next to the code they cover. Tests run via
   `pnpm --filter @slopweaver/cli-tools test` (or just `pnpm test` from root).
5. Update this README under `## Subcommands`.

For interactive prompts, use `@inquirer/prompts` (`confirm`, `input`, `select`,
etc.) and inject the prompt function in your orchestrator so tests can stub it.

Keep subcommands narrow. If a subcommand grows beyond ~150 lines or pulls in
heavyweight deps, consider promoting it to its own package.

> **Convention:** subcommand names should be single tokens like `doctor`,
> `worktree-new`, `connect-local`. `cac` 7.0.0 does not dispatch multi-word
> command names (`cli.command('worktree new <name>', ...)`'s action never
> fires), so use a hyphen instead of a space for compound commands.

## Scripts

- `pnpm --filter @slopweaver/cli-tools test` -- run the Vitest suite once.
- `pnpm --filter @slopweaver/cli-tools test:watch` -- run Vitest in watch mode.
- `pnpm --filter @slopweaver/cli-tools compile` -- type-check (`tsc --noEmit`).
