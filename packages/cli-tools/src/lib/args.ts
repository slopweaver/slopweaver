/**
 * CLI argument parsing utilities.
 *
 * Pure functions for parsing command-line arguments. Used by subcommands
 * that handle their own argv (currently only orchestration's standalone
 * help path); cac handles the main wiring in cli.ts.
 */

export function hasFlag({
  args,
  long,
  short,
}: {
  args: readonly string[];
  long: string;
  short?: string | undefined;
}): boolean {
  return args.includes(`--${long}`) || (short !== undefined && args.includes(`-${short}`));
}

export function isHelpRequested({ args }: { args: readonly string[] }): boolean {
  return hasFlag({ args, long: 'help', short: 'h' });
}
