/**
 * A thin stderr logger for the CLI. Diagnostics (errors, usage, warnings, progress) go HERE; a
 * command's actual data output (a table, an id, a JSON blob) is NOT a log — it stays raw on stdout via
 * `out()` so piping keeps working. Keeping the two streams apart is the whole point: `slopweaver ask
 * "..." | grep ...` must see only the answer, never a warning line.
 *
 * Pure-testable by construction: the only side effect is the injectable `sink`, so a test passes an
 * array-push sink and asserts the exact emitted lines (no mocks, no IO).
 */

export type LogLevel = "error" | "warn" | "info" | "debug";

export interface Logger {
  error(msg: string): void;
  warn(msg: string): void;
  info(msg: string): void;
  debug(msg: string): void;
  /**
   * Raw DATA output: writes `${line}\n` to STDOUT with no level gate and no prefix. This is a command's
   * actual output, not a diagnostic — it must stay on stdout so `… | grep` sees only the data. Distinct
   * from every other method here, which are level-gated diagnostics on stderr.
   */
  out(line: string): void;
}

export interface CreateLoggerOpts {
  /** Minimum level to emit. error < warn < info < debug. Default `info`. */
  readonly level?: LogLevel;
  /** Where each diagnostic line goes. Default writes `${line}\n` to process.stderr. */
  readonly sink?: (line: string) => void;
  /** Where each `out` (data) line goes. Default writes `${line}\n` to process.stdout. */
  readonly outSink?: (line: string) => void;
}

/** Severity order: a level emits only when it is at or below the configured threshold. */
const LEVEL_RANK: Record<LogLevel, number> = { debug: 3, error: 0, info: 2, warn: 1 };

function defaultSink(line: string): void {
  process.stderr.write(`${line}\n`);
}

function defaultOutSink(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * Build a logger. `level` gates output (a `debug` call is dropped at the default `info` level); `sink`
 * is the single side-effect seam. A `--quiet` caller passes `level: 'error'`, `--verbose` passes
 * `level: 'debug'`.
 */
export function createLogger(opts?: CreateLoggerOpts): Logger {
  const threshold = LEVEL_RANK[opts?.level ?? "info"];
  const sink = opts?.sink ?? defaultSink;
  const outSink = opts?.outSink ?? defaultOutSink;
  const emit = (level: LogLevel, msg: string): void => {
    if (LEVEL_RANK[level] <= threshold) {
      sink(msg);
    }
  };
  return {
    debug: (msg) => {
      emit("debug", msg);
    },
    error: (msg) => {
      emit("error", msg);
    },
    info: (msg) => {
      emit("info", msg);
    },
    out: (line) => {
      outSink(line);
    },
    warn: (msg) => {
      emit("warn", msg);
    },
  };
}

/**
 * The process-wide default logger (default level, stderr sink). Runners log diagnostics through this
 * directly instead of each threading its own injected `Logger` — the only reason to build a bespoke
 * logger is a test (array sink) or a `--quiet`/`--verbose` level override.
 */
export const logger = createLogger();
