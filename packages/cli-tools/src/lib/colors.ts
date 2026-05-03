/**
 * ANSI color codes for terminal output.
 *
 * Used by the orchestration CLI for human-readable status output. Kept as
 * raw escape codes (not picocolors) because the orchestration code was
 * ported verbatim and uses these constants directly inline.
 */

export const GREEN = '\x1b[32m';
export const YELLOW = '\x1b[33m';
export const BLUE = '\x1b[34m';
export const NC = '\x1b[0m';
