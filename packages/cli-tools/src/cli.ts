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
import { runAndExit as runCheckServiceBoundaries } from './check-neverthrow-service-boundaries/index.ts';
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
    if (result.isErr()) {
      console.error(`error: ${result.error.message}`);
      const exitCode = 'exitCode' in result.error ? result.error.exitCode : 1;
      process.exit(exitCode);
    }
  });

cli
  .command(
    'check-service-boundaries',
    'Fail if `throw` statements appear in service-boundary files (see #41)',
  )
  .example('  pnpm cli check-service-boundaries')
  .action(() => {
    runCheckServiceBoundaries();
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
  .option(
    '--executor <mode>',
    'Launcher mode: hybrid or codex-only (prepare only; run is always codex-only)',
    { default: 'hybrid' },
  )
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
      if (subcommand === 'prepare') {
        const executorResult = normalizeExecutor(options.executor);
        if (executorResult.isErr()) {
          console.error(executorResult.error.message);
          process.exit(1);
        }
        const result = await prepare(chainPath, {
          executor: executorResult.value,
          restart: options.restart === true,
        });
        if (result.isErr()) {
          console.error(result.error.message);
          process.exit(1);
        }
        return;
      }
      if (subcommand === 'run') {
        // `run` is the codex-only fallback runner. The hybrid (Claude-implements)
        // path is driven by `prepare` + a Claude-side launcher, which is the
        // maintainer's external tool. Hardcode codex-only here so passing
        // `--executor hybrid` to `run` doesn't silently behave as codex-only
        // with hybrid prompt wording.
        const result = await run(chainPath, {
          dryRun: options.dryRun === true,
          executor: 'codex-only',
          notify: options.notify === true,
          restart: options.restart === true,
        });
        if (result.isErr()) {
          console.error(result.error.message);
          process.exit(1);
        }
        return;
      }
      console.error(`Unknown subcommand: ${subcommand}. Use 'prepare' or 'run'.`);
      process.exit(1);
    },
  );

cli.help();
cli.version('0.0.0');
cli.parse();
