#!/usr/bin/env node

/**
 * SlopWeaver developer CLI entry point.
 *
 * Invoked as `pnpm cli <subcommand>` from the workspace root, which runs
 * `tsx packages/cli-tools/src/cli.ts <subcommand>` (configured in root
 * package.json). Subcommands live under `src/<name>/`.
 *
 * v1: just `worktree`. More land as the project grows.
 */

import { cac } from 'cac';
import { runWorktreeNew } from './worktree/index.ts';

const cli = cac('slopweaver-cli');

cli
  .command(
    'worktree new <name>',
    'Create a fresh git worktree from origin/main, on branch worktree/<name>',
  )
  .option('--no-install', 'Skip `pnpm install` in the new worktree')
  .example('  pnpm cli worktree new fix-issue-42')
  .action((name: string, options: { install: boolean }) => {
    runWorktreeNew({ rawName: name, options: { install: options.install } });
  });

cli.help();
cli.version('0.0.0');
cli.parse();
