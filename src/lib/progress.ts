/**
 * A thin, non-blocking, session-visible progress emitter — so a long `refresh`/`distil`/`embed` run
 * shows cheap, adaptive progress in the Claude session instead of a dead terminal for 35 minutes.
 *
 * HARD constraint: nothing here may block the terminal. It writes ONE structured JSON line per emitted
 * event (never a spinner, cursor control, or `readline`), and never assumes a TTY. The sink and clock
 * are injected, so the pure emit/cadence logic is unit-tested with a fake clock + a capturing sink.
 *
 * Cadence is adaptive so the output is readable, not a flood: a small job emits count milestones; a
 * normal job emits ~once/minute; a large job backs off to ~once/5-minutes (plus an always-emitted first
 * and final line). The exact policy is the pure {@link progressCadence}.
 */

/** Where a progress line goes. Defaults to stdout; a test injects a capturing sink. Never awaited. */
export type ProgressSink = (line: string) => void;

/** The adaptive-cadence policy: how often to emit between the guaranteed first and final lines. */
export interface ProgressCadence {
  /** Minimum ms between time-gated emits (`0` ⇒ time gate off, rely on milestones). */
  readonly minIntervalMs: number;
  /** Emit whenever `done` is a multiple of this (`0` ⇒ milestone gate off). */
  readonly milestoneEvery: number;
}

/**
 * Choose the emit cadence from the workload size — decided up-front so the line rate stays cheap:
 * a small job emits ~10 milestone lines; a normal job ~once/minute; a large job ~once/5-minutes. Pure.
 *
 * @param total the expected number of units of work (0/unknown ⇒ treated as small)
 * @returns the interval + milestone gates
 */
export function progressCadence({ total }: { total: number }): ProgressCadence {
  if (total <= 200) {
    return { milestoneEvery: Math.max(1, Math.ceil(total / 10)), minIntervalMs: 0 };
  }
  if (total <= 5000) {
    return { milestoneEvery: 0, minIntervalMs: 60_000 };
  }
  return { milestoneEvery: 0, minIntervalMs: 300_000 };
}

/** One progress update — a phase label plus cheap counts (never records or prompt text). */
export interface ProgressUpdate {
  readonly phase: string;
  readonly done?: number;
  readonly total?: number;
  /** Extra cheap counters (e.g. `{ cached: 7, called: 5 }`). */
  readonly counts?: Readonly<Record<string, number>>;
}

/** A non-blocking progress emitter bound to one verb. */
export interface ProgressEmitter {
  /** Emit an update if the cadence allows (the first update always emits). Non-blocking. */
  update(u: ProgressUpdate): void;
  /** Emit a final update unconditionally (run finished / interrupted). Non-blocking. */
  finish(u: ProgressUpdate): void;
}

const defaultSink: ProgressSink = (line) => {
  process.stdout.write(line);
};

/**
 * Build a progress emitter for one verb. Writes `{"type":"slopweaver.progress",...}` JSON lines through
 * the sink, gated by {@link progressCadence} (unless `cadence` is given). The first `update` and every
 * `finish` always emit; in between, a time gate and/or milestone gate decide. Never blocks (the sink's
 * return value is ignored — no drain await).
 *
 * @param verb the verb name stamped on every line (e.g. "distil")
 * @param now injected monotonic clock in ms (defaults to `Date.now`)
 * @param sink where lines go (defaults to stdout)
 * @param cadence explicit cadence override (defaults to size-adaptive from each update's `total`)
 * @returns the emitter
 */
export function createProgressEmitter({
  verb,
  now = Date.now,
  sink = defaultSink,
  cadence,
}: {
  verb: string;
  now?: () => number;
  sink?: ProgressSink;
  cadence?: ProgressCadence;
}): ProgressEmitter {
  const startMs = now();
  let lastEmitMs: number | undefined;

  const emit = (u: ProgressUpdate): void => {
    const line: Record<string, string | number> = { phase: u.phase, type: "slopweaver.progress", verb };
    if (u.done !== undefined) {
      line["done"] = u.done;
    }
    if (u.total !== undefined) {
      line["total"] = u.total;
    }
    for (const [key, value] of Object.entries(u.counts ?? {})) {
      line[key] = value;
    }
    line["elapsedMs"] = now() - startMs;
    lastEmitMs = now();
    sink(`${JSON.stringify(line)}\n`);
  };

  const policy = (u: ProgressUpdate): ProgressCadence => cadence ?? progressCadence({ total: u.total ?? 0 });

  return {
    finish: (u) => {
      emit(u);
    },
    update: (u) => {
      if (lastEmitMs === undefined) {
        emit(u); // the first update always emits
        return;
      }
      const { minIntervalMs, milestoneEvery } = policy(u);
      const timeReady = minIntervalMs > 0 && now() - lastEmitMs >= minIntervalMs;
      const milestoneReady = milestoneEvery > 0 && u.done !== undefined && u.done % milestoneEvery === 0;
      if (timeReady || milestoneReady) {
        emit(u);
      }
    },
  };
}
