# @slopweaver/cli-tools

Developer CLI for working in the SlopWeaver monorepo.

Invoke from the workspace root:

```bash
pnpm cli <subcommand> [options]
```

Implementation: `tsx`-executed TypeScript source (no build step). Modern ESM.
[`cac`](https://github.com/cacjs/cac) for argument parsing.

## Subcommands

### `worktree new <name>`

Creates a fresh git worktree from `origin/main`, one directory up from the
monorepo root, on a new branch `worktree/<name>`. Installs dependencies in
the new worktree by default.

```bash
pnpm cli worktree new fix-issue-42
# creates ~/dev/worktrees/fix-issue-42 on branch worktree/fix-issue-42
# runs pnpm install in the new worktree

pnpm cli worktree new quick-fix --no-install
# skip the pnpm install step
```

This is the recommended way to start work on an issue or feature so the
main checkout stays clean and you can run multiple parallel work streams.

## Adding a subcommand

1. Create `src/<subcommand>/index.ts` exporting a `run<Subcommand>(...)` function.
2. Wire it up in `src/cli.ts` with a new `cli.command(...).action(...)` block.
3. Update this README under `## Subcommands`.
4. Add tests when the subcommand has logic worth testing (sanitisation, parsing, etc.).

Keep subcommands narrow. If a subcommand grows beyond ~150 lines or pulls in
heavyweight deps, consider promoting it to its own package.
