#!/usr/bin/env node

/**
 * SlopWeaver developer CLI entry point.
 *
 * Invoked as `pnpm cli <subcommand>` from the workspace root, which runs
 * `tsx packages/cli-tools/src/cli.ts <subcommand>` (configured in root
 * package.json). Subcommands live under `src/<name>/`.
 *
 * v1 subcommands: `worktree`, `doctor`. More land as the project grows.
 */

import { cac } from 'cac';
import { runDoctor } from './doctor/index.ts';
import { runWorktreeNew } from './worktree/index.ts';

const cli = cac('slopweaver-cli');

cli
  .command(
    'worktree-new <name>',
    'Create a fresh git worktree from origin/main, on branch worktree/<name>',
  )
  .option('--no-install', 'Skip `pnpm install` in the new worktree')
  .example('  pnpm cli worktree-new fix-issue-42')
  .action((name: string, options: { install: boolean }) => {
    const result = runWorktreeNew({ rawName: name, options: { install: options.install } });
    if (!result.ok) {
      console.error(`error: ${result.error}`);
      process.exit(result.exitCode);
    }
  });

cli
  .command('doctor', 'Check your local environment is ready for SlopWeaver dev')
  .example('  pnpm cli doctor')
  .action(() => {
    runDoctor()
      .then((result) => {
        if (!result.ok) {
          process.exit(result.exitCode);
        }
      })
      .catch((err: unknown) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      });
  });

cli.help();
cli.version('0.0.0');
cli.parse();
