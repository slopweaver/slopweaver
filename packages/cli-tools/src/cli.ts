#!/usr/bin/env node

/**
 * SlopWeaver developer CLI entry point.
 *
 * Invoked as `pnpm cli <subcommand>` from the workspace root, which runs
 * `tsx packages/cli-tools/src/cli.ts <subcommand>` (configured in root
 * package.json). Subcommands live under `src/<name>/`.
 *
 * v1 subcommands: `worktree-new`, `doctor`, `orchestration prepare/run`.
 */

import { cac } from 'cac';
import { runDoctor } from './doctor/index.ts';
import { normalizeExecutor, prepare, run } from './orchestration/index.ts';
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

cli
  .command(
    'orchestration <subcommand> <chainPath>',
    'Run an orchestration chain. Subcommands: prepare | run',
  )
  .option('--executor <mode>', 'Launcher mode: hybrid or codex-only', { default: 'hybrid' })
  .option('--dry-run', 'Print the resolved phase order and exit (run only)')
  .option('--restart', 'Discard saved runner state before starting')
  .option('--notify', 'Send cmux notifications at the manual stop point (run only)')
  .example('  pnpm cli orchestration prepare @docs/orchestration/examples/refactor-example.md')
  .example(
    '  pnpm cli orchestration run @docs/orchestration/examples/refactor-example.md --dry-run',
  )
  .action(
    async (
      subcommand: string,
      chainPath: string,
      options: { executor: string; dryRun?: boolean; notify?: boolean; restart?: boolean },
    ) => {
      try {
        if (subcommand === 'prepare') {
          await prepare(chainPath, {
            executor: normalizeExecutor(options.executor),
            restart: options.restart === true,
          });
          return;
        }
        if (subcommand === 'run') {
          await run(chainPath, {
            dryRun: options.dryRun === true,
            executor: normalizeExecutor(options.executor),
            notify: options.notify === true,
            restart: options.restart === true,
          });
          return;
        }
        throw new Error(`Unknown subcommand: ${subcommand}. Use 'prepare' or 'run'.`);
      } catch (err: unknown) {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      }
    },
  );

cli.help();
cli.version('0.0.0');
cli.parse();
