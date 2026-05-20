/**
 * Work-console config. Owns the per-process knobs that describe where the
 * console lives, what branch it lives on, and what layout we expect.
 *
 * All defaults are zero-config: a user who runs `claude mcp add slopweaver`
 * and never touches any environment variable gets a sensible
 * `.claude/personal/` tree on a branch called `ai-work-console`.
 */

import { isAbsolute, resolve } from 'node:path';

export const DEFAULT_WORK_CONSOLE_BRANCH = 'ai-work-console';
export const DEFAULT_CONSOLE_REL_DIR = '.claude/personal';
export const DEFAULT_FEEDBACK_REL_PATH = '.claude/personal/state/lock-in-feedback.jsonl';

export type WorkConsoleConfig = {
  /** Absolute path to the working directory used as the git repo root + console anchor. */
  readonly cwd: string;
  /** Git branch name the console is required to live on. */
  readonly branch: string;
  /** Relative directory under cwd that holds all console markdown. */
  readonly consoleRelDir: string;
  /** Relative path under cwd where the walk-feedback JSONL is appended. */
  readonly feedbackRelPath: string;
};

export type ResolveWorkConsoleConfigArgs = {
  cwd?: string;
  branch?: string;
  consoleRelDir?: string;
  feedbackRelPath?: string;
  env?: Record<string, string | undefined>;
};

/**
 * Resolve a {@link WorkConsoleConfig} from optional overrides + environment.
 * Order of precedence (highest first):
 *
 *   1. Explicit `args` overrides (passed by tests).
 *   2. Environment: `SLOPWEAVER_CONSOLE_BRANCH`, `SLOPWEAVER_CONSOLE_DIR`,
 *      `SLOPWEAVER_FEEDBACK_LOG`.
 *   3. Built-in defaults.
 *
 * Never reads files; this is a synchronous, pure-ish resolver. The only
 * impurity is `process.cwd()` when `cwd` isn't supplied — tests inject `cwd`
 * to avoid that.
 */
export function resolveWorkConsoleConfig(args: ResolveWorkConsoleConfigArgs = {}): WorkConsoleConfig {
  const env = args.env ?? {};
  const cwd = args.cwd ?? process.cwd();
  const absCwd = isAbsolute(cwd) ? cwd : resolve(cwd);
  const branch = args.branch ?? env['SLOPWEAVER_CONSOLE_BRANCH']?.trim() ?? DEFAULT_WORK_CONSOLE_BRANCH;
  const consoleRelDir = args.consoleRelDir ?? env['SLOPWEAVER_CONSOLE_DIR']?.trim() ?? DEFAULT_CONSOLE_REL_DIR;
  const feedbackRelPath = args.feedbackRelPath ?? env['SLOPWEAVER_FEEDBACK_LOG']?.trim() ?? DEFAULT_FEEDBACK_REL_PATH;
  return Object.freeze({
    cwd: absCwd,
    branch: branch || DEFAULT_WORK_CONSOLE_BRANCH,
    consoleRelDir: consoleRelDir || DEFAULT_CONSOLE_REL_DIR,
    feedbackRelPath: feedbackRelPath || DEFAULT_FEEDBACK_REL_PATH,
  });
}
