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

import { type RenderableProgressEvent, renderProgressEvent } from "./progressRender.js";

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

// ─────────────────────────────────────────────────────────────────────────────
// PR4.4c — the rich, streamed progress model. A long crawl becomes WATCHABLE: a
// throttled human line per event (to stderr) plus the machine `slopweaver.progress`
// JSON (also off stdout, so `--json` stays pristine). Three lanes, ported (design
// only) from the archive's SSE model: a `heartbeat` (source · X/Y · % · ETA ·
// currently-scanning), a `content_preview` (a redacted taste of what's being read),
// and `knowledge_extracted` (learnings as they arrive). Everything below the emitter
// is PURE + unit-tested with a fake clock + capturing sink — the crawl-side wiring is
// the only effectful edge, and it is fire-and-forget (a throwing sink never aborts).
// ─────────────────────────────────────────────────────────────────────────────

/** Which streamed lane an event belongs to (each throttled independently). */
export type ProgressLane = "heartbeat" | "content_preview" | "knowledge_extracted";

/** The single item a heartbeat is currently on (a channel, repo, ticket, page). */
export interface ProgressCurrentItem {
  readonly title: string;
  readonly label?: string;
  readonly url?: string;
}

/** A taste of what's being read right now — its text ALREADY redacted by the caller. */
export interface ProgressPreview {
  readonly subject: string;
  readonly snippet: string;
  readonly sourceContentId: string;
  readonly sender?: string;
}

/** One learning surfaced as it arrives (distil only), with its grounding cite. */
export interface ProgressLearning {
  readonly category: "decision" | "blocker" | "ownership" | "status" | "opportunity";
  readonly confidence: "low" | "medium" | "high";
  readonly content: string;
  readonly sourceContentId: string;
}

/** One rich event fed into the emitter from a crawl/stage (never carries a raw secret). */
export interface RichProgressEvent {
  readonly lane: ProgressLane;
  readonly phase: string;
  readonly done?: number;
  readonly total?: number;
  readonly currentItem?: ProgressCurrentItem;
  readonly metrics?: Readonly<Record<string, number>>;
  readonly preview?: ProgressPreview;
  readonly learning?: ProgressLearning;
}

/** The throttle intervals (ms) + EMA smoothing — the emit-cadence policy for the rich lanes. */
export interface ProgressConfig {
  readonly heartbeatMs: number;
  readonly previewMs: number;
  readonly learningMs: number;
  readonly stallMs: number;
  readonly emaAlpha: number;
}

/** The locked cadence (realigned spec): heartbeat 5s · preview 20s · learning 10s · stall 60s · EMA α 0.25. */
export const DEFAULT_PROGRESS_CONFIG: ProgressConfig = {
  emaAlpha: 0.25,
  heartbeatMs: 5_000,
  learningMs: 10_000,
  previewMs: 20_000,
  stallMs: 60_000,
};

/** The accumulating pure state a stream of events folds into (threaded through {@link nextProgressState}). */
export interface ProgressState {
  readonly verb: string;
  readonly startMs: number;
  readonly phase: string;
  readonly done?: number;
  readonly total?: number;
  readonly percent?: number;
  readonly rate?: number;
  readonly realDeltas: number;
  readonly lastDone?: number;
  readonly lastSampleMs?: number;
  readonly metrics: Readonly<Record<string, number>>;
  readonly currentItem?: ProgressCurrentItem;
  readonly lastEmitMs: Readonly<Partial<Record<ProgressLane, number>>>;
  readonly lastUpdateMs: number;
}

/** A rendered-ready snapshot of the current heartbeat state (collapsed step + monotonic % + EMA ETA). */
export interface ProgressSnapshot {
  readonly verb: string;
  readonly phase: string;
  readonly step: string;
  readonly source?: string;
  readonly done?: number;
  readonly total?: number;
  readonly percent?: number;
  readonly etaSeconds?: number;
  readonly elapsedMs: number;
  readonly currentItem?: ProgressCurrentItem;
  readonly metrics: Readonly<Record<string, number>>;
  readonly stalled: boolean;
}

/** The sources whose phase strings (`slack.channel`, `github.repos`, …) carry a leading source token. */
const PHASE_SOURCES: ReadonlySet<string> = new Set(["github", "slack", "linear", "notion"]);

/** Raw connector/stage phase → one of ~a-dozen human steps. A leading `source.` prefix is stripped first. */
const PHASE_STEPS: Readonly<Record<string, string>> = {
  batch: "Distilling batches",
  "build-directory": "Building directory",
  "build-graphs": "Building graphs",
  "github.items": "Reading activity",
  "github.repos": "Reading repositories",
  "linear.issues": "Reading issues",
  "linear.projects": "Reading projects",
  members: "Linking people",
  "notion.databases": "Reading databases",
  "notion.pages": "Reading pages",
  "read-corpus": "Reading corpus",
  "resolve-identities": "Resolving identities",
  "slack.channel": "Reading channel",
  "slack.thread": "Reading threads",
  structures: "Mapping structure",
  "write-silver": "Writing silver",
};

/** Title-case a raw phase segment as the fallback human step (e.g. `foo-bar` → `Foo bar`). Pure. */
function titleiseStep({ raw }: { raw: string }): string {
  const spaced = raw.replace(/[._-]+/g, " ").trim();
  return spaced.length === 0 ? raw : `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}`;
}

/**
 * Collapse a raw connector/stage phase into a short human step (the ~5-phase "collapse raw phases" rule).
 * Unknown phases title-case gracefully so a new lane still reads well. Pure.
 *
 * @param verb the verb (reserved for future verb-specific collapse; kept for a stable signature)
 * @param phase the raw phase string (e.g. `slack.channel`, `github.repos`, `batch`)
 * @returns the human step label
 */
export function collapseProgressPhase({ phase }: { verb: string; phase: string }): string {
  return PHASE_STEPS[phase] ?? titleiseStep({ raw: phase });
}

/** The source token a phase carries (`slack.channel` → `slack`), or undefined for a sourceless phase. Pure. */
export function phaseSource({ phase }: { phase: string }): string | undefined {
  const head = phase.split(".")[0];
  return head !== undefined && PHASE_SOURCES.has(head) ? head : undefined;
}

/**
 * The monotonic completion percent: hidden (undefined) until BOTH `done` and `total` are positive — no
 * fake "2% / 0 items" — then `floor(done/total*100)` clamped to `[previous, 100]` so it never goes
 * backwards (a later source with a smaller ratio can't rewind the bar). Pure.
 *
 * @param previous the last shown percent (undefined ⇒ never shown yet)
 * @param done items processed so far
 * @param total items expected
 * @returns the percent to show, or undefined to keep it hidden
 */
export function monotonicPercent({
  previous,
  done,
  total,
}: {
  previous: number | undefined;
  done: number | undefined;
  total: number | undefined;
}): number | undefined {
  if (done === undefined || total === undefined || done <= 0 || total <= 0) {
    return previous;
  }
  const raw = Math.min(100, Math.floor((done / total) * 100));
  return Math.max(previous ?? 0, raw);
}

/**
 * Update the EMA throughput (items/sec). A non-positive delta or elapsed carries no new signal, so the
 * previous rate stands. The first real sample seeds the average; later ones smooth it (α weights the
 * newest). Pure — no wall-clock read, so it's testable with an injected elapsed. Pure.
 *
 * @param previousRate the prior EMA rate (undefined ⇒ unseeded)
 * @param doneDelta items completed since the last sample
 * @param elapsedMs ms since the last sample
 * @param alpha the EMA smoothing factor (0..1)
 * @returns the updated rate, or the previous one when there's no new signal
 */
export function updateEmaRate({
  previousRate,
  doneDelta,
  elapsedMs,
  alpha,
}: {
  previousRate: number | undefined;
  doneDelta: number;
  elapsedMs: number;
  alpha: number;
}): number | undefined {
  if (doneDelta <= 0 || elapsedMs <= 0) {
    return previousRate;
  }
  const instant = doneDelta / (elapsedMs / 1000);
  return previousRate === undefined ? instant : alpha * instant + (1 - alpha) * previousRate;
}

/**
 * Seconds remaining at the current EMA rate, or undefined when the rate is unusable (unseeded/zero) or
 * nothing is left. Pure.
 *
 * @param rate the EMA throughput (items/sec)
 * @param remaining items left to process
 * @returns the ETA in seconds, or undefined
 */
export function etaSeconds({ rate, remaining }: { rate: number | undefined; remaining: number }): number | undefined {
  if (rate === undefined || rate <= 0 || remaining <= 0) {
    return undefined;
  }
  return Math.round(remaining / rate);
}

/** The rate-fields left UNCHANGED (an event that didn't move `done` forward carries the prior sample). Pure. */
function carryRate({ state }: { state: ProgressState }): {
  rate?: number;
  realDeltas: number;
  lastDone?: number;
  lastSampleMs?: number;
} {
  return {
    realDeltas: state.realDeltas,
    ...(state.rate !== undefined ? { rate: state.rate } : {}),
    ...(state.lastDone !== undefined ? { lastDone: state.lastDone } : {}),
    ...(state.lastSampleMs !== undefined ? { lastSampleMs: state.lastSampleMs } : {}),
  };
}

/** The EMA-rate advance for one event (only a forward `done` move updates the rate). Pure. */
function advanceRate({
  state,
  event,
  nowMs,
  alpha,
}: {
  state: ProgressState;
  event: RichProgressEvent;
  nowMs: number;
  alpha: number;
}): { rate?: number; realDeltas: number; lastDone?: number; lastSampleMs?: number } {
  if (event.done === undefined) {
    return carryRate({ state });
  }
  const moved = state.lastDone === undefined || event.done > state.lastDone;
  if (!moved) {
    return carryRate({ state });
  }
  const doneDelta = event.done - (state.lastDone ?? 0);
  const elapsedMs = nowMs - (state.lastSampleMs ?? state.startMs);
  const nextRate = updateEmaRate({ alpha, doneDelta, elapsedMs, previousRate: state.rate });
  // A "real delta" is a usable forward sample (positive move + positive elapsed) — the ETA-gate counter,
  // independent of whether the numeric rate happened to change between two equally-paced samples.
  const usable = doneDelta > 0 && elapsedMs > 0;
  return {
    lastDone: event.done,
    lastSampleMs: nowMs,
    realDeltas: usable ? state.realDeltas + 1 : state.realDeltas,
    ...(nextRate !== undefined ? { rate: nextRate } : {}),
  };
}

/** A fresh state for one verb's run (nothing seen yet — percent/ETA stay hidden until real data). Pure. */
export function initialProgressState({ verb, startMs }: { verb: string; startMs: number }): ProgressState {
  return { lastEmitMs: {}, lastUpdateMs: startMs, metrics: {}, phase: "", realDeltas: 0, startMs, verb };
}

/**
 * Clear the per-phase progress tracking (done/total/percent/rate/EMA-sample/currentItem) while keeping the
 * run-level fields (verb/startMs) + the throttle clocks. Used on a PHASE change so each phase computes its
 * own percent/ETA from scratch — a later phase with a smaller `done` scale (a smaller source, or Linear
 * issues→projects) must not be frozen by the prior phase's higher `lastDone`/`percent`. Pure.
 */
function clearPhaseTracking({ state }: { state: ProgressState }): ProgressState {
  return {
    lastEmitMs: state.lastEmitMs,
    lastUpdateMs: state.lastUpdateMs,
    metrics: state.metrics,
    phase: state.phase,
    realDeltas: 0,
    startMs: state.startMs,
    verb: state.verb,
  };
}

/**
 * Fold one event into the progress state: advance phase, done/total, the monotonic percent, the EMA rate,
 * merge metrics, and stamp `lastUpdateMs` (the stall clock). Does NOT touch the per-lane emit timestamps —
 * those move only when a line is actually emitted (see {@link markEmitted}). Pure.
 *
 * @param state the state so far
 * @param event the incoming event
 * @param nowMs the injected clock
 * @param config the cadence/EMA policy
 * @returns the next state
 */
export function nextProgressState({
  state,
  event,
  nowMs,
  config,
}: {
  state: ProgressState;
  event: RichProgressEvent;
  nowMs: number;
  config: ProgressConfig;
}): ProgressState {
  // A phase change (a new source, or a new stage within one source with its own `done` scale) resets the
  // percent/ETA/EMA tracking, so each phase measures itself — never frozen by a prior phase's larger counts.
  const prior = state.phase !== "" && state.phase !== event.phase ? clearPhaseTracking({ state }) : state;
  const done = event.done ?? prior.done;
  const total = event.total ?? prior.total;
  const percent = monotonicPercent({ done, previous: prior.percent, total });
  const currentItem = event.currentItem ?? prior.currentItem;
  const advanced = advanceRate({ alpha: config.emaAlpha, event, nowMs, state: prior });
  return {
    ...advanced,
    lastEmitMs: prior.lastEmitMs,
    lastUpdateMs: nowMs,
    // Metrics REPLACE (not merge): connectors emit cumulative running totals each heartbeat, so replacing
    // shows each source's own counts and never bleeds one source's metrics (e.g. github `records`) onto the
    // next's line. A metric-less event (e.g. a "starting" heartbeat) simply shows no metrics clause.
    metrics: event.metrics ?? {},
    phase: event.phase,
    startMs: state.startMs,
    verb: state.verb,
    ...(done !== undefined ? { done } : {}),
    ...(total !== undefined ? { total } : {}),
    ...(percent !== undefined ? { percent } : {}),
    ...(currentItem !== undefined ? { currentItem } : {}),
  };
}

/** Record that a `lane` line was emitted at `nowMs` (resets that lane's throttle window). Pure. */
export function markEmitted({
  state,
  lane,
  nowMs,
}: {
  state: ProgressState;
  lane: ProgressLane;
  nowMs: number;
}): ProgressState {
  return { ...state, lastEmitMs: { ...state.lastEmitMs, [lane]: nowMs } };
}

/** The throttle interval (ms) for a lane. Pure. */
function laneIntervalMs({ lane, config }: { lane: ProgressLane; config: ProgressConfig }): number {
  if (lane === "content_preview") {
    return config.previewMs;
  }
  if (lane === "knowledge_extracted") {
    return config.learningMs;
  }
  return config.heartbeatMs;
}

/**
 * Whether a lane's line should be emitted now: a `final` line always flushes (past the throttle); the
 * first line of a lane always emits; otherwise the lane's interval must have elapsed since its last emit.
 * Pure.
 *
 * @param state the current state (holds the per-lane last-emit clock)
 * @param lane the lane about to emit
 * @param nowMs the injected clock
 * @param final whether this is the forced final line
 * @param config the cadence policy (the per-lane intervals)
 * @returns true to emit
 */
export function shouldEmitProgress({
  state,
  lane,
  nowMs,
  final,
  config,
}: {
  state: ProgressState;
  lane: ProgressLane;
  nowMs: number;
  final: boolean;
  config: ProgressConfig;
}): boolean {
  if (final) {
    return true;
  }
  const last = state.lastEmitMs[lane];
  return last === undefined || nowMs - last >= laneIntervalMs({ config, lane });
}

/** The items still to process (0 when unknown or complete). Pure. */
function remainingOf({ state }: { state: ProgressState }): number {
  if (state.done === undefined || state.total === undefined) {
    return 0;
  }
  return Math.max(0, state.total - state.done);
}

/**
 * Build the render-ready heartbeat snapshot from the state: collapse the phase to a human step, derive the
 * source token, and show the ETA only once at least two real deltas have been seen (no jittery early ETA).
 * Pure.
 *
 * @param state the current state
 * @param nowMs the injected clock (for elapsed)
 * @param stalled whether the stall watchdog fired
 * @returns the snapshot to render
 */
export function progressSnapshot({
  state,
  nowMs,
  stalled,
}: {
  state: ProgressState;
  nowMs: number;
  stalled: boolean;
}): ProgressSnapshot {
  const source = phaseSource({ phase: state.phase });
  const eta = state.realDeltas >= 2 ? etaSeconds({ rate: state.rate, remaining: remainingOf({ state }) }) : undefined;
  return {
    elapsedMs: nowMs - state.startMs,
    metrics: state.metrics,
    phase: state.phase,
    stalled,
    step: collapseProgressPhase({ phase: state.phase, verb: state.verb }),
    verb: state.verb,
    ...(source !== undefined ? { source } : {}),
    ...(state.done !== undefined ? { done: state.done } : {}),
    ...(state.total !== undefined ? { total: state.total } : {}),
    ...(state.percent !== undefined ? { percent: state.percent } : {}),
    ...(eta !== undefined ? { etaSeconds: eta } : {}),
    ...(state.currentItem !== undefined ? { currentItem: state.currentItem } : {}),
  };
}

/**
 * A stall snapshot when no update has landed for `stallAfterMs` (the "no updates for Ns" watchdog),
 * else undefined. Pure — the emitter decides whether to render it.
 *
 * @param state the current state
 * @param nowMs the injected clock
 * @param stallAfterMs the stall threshold
 * @returns a `stalled:true` snapshot, or undefined
 */
export function stalledSnapshot({
  state,
  nowMs,
  stallAfterMs,
}: {
  state: ProgressState;
  nowMs: number;
  stallAfterMs: number;
}): ProgressSnapshot | undefined {
  if (nowMs - state.lastUpdateMs < stallAfterMs) {
    return undefined;
  }
  return progressSnapshot({ nowMs, stalled: true, state });
}

/** The default rich sinks write to STDERR — stdout stays pristine for `--json` data output. */
const stderrSink: ProgressSink = (line) => {
  process.stderr.write(line);
};

/** A rich, three-lane progress emitter bound to one verb — the effectful edge over the pure model above. */
export interface RichProgressEmitter {
  /** Emit an event if its lane's throttle allows (the first line of each lane always emits). Non-blocking. */
  emit(event: RichProgressEvent): void;
  /** Emit a final event unconditionally (past every throttle) — the run's last, complete line. Non-blocking. */
  finish(event: RichProgressEvent): void;
  /** Emit a `(stalled)` heartbeat iff no update has landed for the stall threshold. Best-effort; non-blocking. */
  noteStall(): void;
}

/** The renderable form of an event given its heartbeat snapshot (preview/learning fall back to heartbeat). */
function toRenderable({
  event,
  snapshot,
}: {
  event: RichProgressEvent;
  snapshot: ProgressSnapshot;
}): RenderableProgressEvent {
  if (event.lane === "content_preview" && event.preview !== undefined) {
    return { lane: "content_preview", preview: event.preview };
  }
  if (event.lane === "knowledge_extracted" && event.learning !== undefined) {
    return { lane: "knowledge_extracted", learning: event.learning };
  }
  return { lane: "heartbeat", snapshot };
}

/** The machine `slopweaver.progress` JSON line for one event (the programmatic relay lane, off stdout). */
function machineLine({
  verb,
  event,
  snapshot,
}: {
  verb: string;
  event: RichProgressEvent;
  snapshot: ProgressSnapshot;
}): string {
  const line: Record<string, unknown> = {
    elapsedMs: snapshot.elapsedMs,
    lane: event.lane,
    phase: event.phase,
    type: "slopweaver.progress",
    verb,
    ...(snapshot.done !== undefined ? { done: snapshot.done } : {}),
    ...(snapshot.total !== undefined ? { total: snapshot.total } : {}),
    ...(snapshot.percent !== undefined ? { percent: snapshot.percent } : {}),
    ...(snapshot.etaSeconds !== undefined ? { etaSeconds: snapshot.etaSeconds } : {}),
    ...(Object.keys(snapshot.metrics).length > 0 ? { metrics: snapshot.metrics } : {}),
    ...(snapshot.currentItem !== undefined ? { currentItem: snapshot.currentItem } : {}),
    ...(event.preview !== undefined ? { preview: event.preview } : {}),
    ...(event.learning !== undefined ? { learning: event.learning } : {}),
  };
  return `${JSON.stringify(line)}\n`;
}

/**
 * Starts a repeating stall check (the watchdog). Given the interval + a tick callback, it arranges for the
 * callback to fire roughly every `intervalMs` — production uses a NON-BLOCKING unref'd timer; a test injects
 * a fake that captures the tick and drives it manually. Absent ⇒ no watchdog (the default).
 */
export type StallTimer = (args: { intervalMs: number; onTick: () => void }) => void;

/**
 * The production stall watchdog: a `setInterval` that's `unref`'d so it NEVER keeps the process alive or
 * blocks exit — it just nudges the emitter to print a `(stalled)` line if the crawl has gone quiet.
 *
 * @param intervalMs how often to check
 * @param onTick the stall check to run
 */
export const unrefIntervalStallTimer: StallTimer = ({ intervalMs, onTick }) => {
  const handle = setInterval(onTick, intervalMs);
  if (typeof handle.unref === "function") {
    handle.unref();
  }
};

/**
 * Build a rich progress emitter for one verb. Each emitted event writes ONE human line (through `humanSink`)
 * and ONE machine JSON line (through `machineSink`) — both default to STDERR so stdout stays clean for
 * `--json`. Emits are throttled per lane by {@link shouldEmitProgress} (the first line of each lane and
 * every `finish` bypass the throttle). Fire-and-forget: a throwing sink is swallowed so a broken relay can
 * NEVER abort or corrupt the crawl. The clock is injected, so the whole thing is deterministic in tests.
 * When a `stallTimer` is given, a watchdog prints a `(stalled)` heartbeat if no update lands for `stallMs`.
 *
 * @param verb the verb name stamped on every line
 * @param now injected monotonic clock in ms (defaults to `Date.now`)
 * @param humanSink where human lines go (defaults to stderr)
 * @param machineSink where machine JSON lines go (defaults to stderr)
 * @param config the cadence/EMA policy (defaults to {@link DEFAULT_PROGRESS_CONFIG})
 * @param stallTimer starts the stall watchdog (production: {@link unrefIntervalStallTimer}; omit ⇒ no watchdog)
 * @returns the rich emitter
 */
export function createRichProgressEmitter({
  verb,
  now = Date.now,
  humanSink = stderrSink,
  machineSink = stderrSink,
  config = DEFAULT_PROGRESS_CONFIG,
  stallTimer,
}: {
  verb: string;
  now?: () => number;
  humanSink?: ProgressSink;
  machineSink?: ProgressSink;
  config?: ProgressConfig;
  stallTimer?: StallTimer;
}): RichProgressEmitter {
  let state = initialProgressState({ startMs: now(), verb });
  // Fire-and-forget: a broken/absent sink is swallowed so the crawl always runs on (the realigned hard rule).
  const fire = ({ sink, line }: { sink: ProgressSink; line: string }): void => {
    try {
      sink(line);
    } catch {
      /* progress is best-effort */
    }
  };
  const render = ({ event, snapshot }: { event: RichProgressEvent; snapshot: ProgressSnapshot }): void => {
    fire({ line: `${renderProgressEvent({ event: toRenderable({ event, snapshot }) })}\n`, sink: humanSink });
    fire({ line: machineLine({ event, snapshot, verb }), sink: machineSink });
  };
  const write = ({ event, final }: { event: RichProgressEvent; final: boolean }): void => {
    const nowMs = now();
    const next = nextProgressState({ config, event, nowMs, state });
    if (!shouldEmitProgress({ config, final, lane: event.lane, nowMs, state: next })) {
      state = next; // fold the content, but stay silent until the lane's window opens
      return;
    }
    render({ event, snapshot: progressSnapshot({ nowMs, stalled: false, state: next }) });
    state = markEmitted({ lane: event.lane, nowMs, state: next });
  };
  // Emit a `(stalled)` heartbeat iff no update has landed for the stall threshold (best-effort; non-blocking).
  const checkStall = (): void => {
    const nowMs = now();
    const snapshot = stalledSnapshot({ nowMs, stallAfterMs: config.stallMs, state });
    if (snapshot !== undefined) {
      render({ event: { lane: "heartbeat", phase: state.phase }, snapshot });
      state = markEmitted({ lane: "heartbeat", nowMs, state });
    }
  };
  stallTimer?.({ intervalMs: config.stallMs, onTick: checkStall }); // start the watchdog when one is provided
  return {
    emit: (event) => {
      write({ event, final: false });
    },
    finish: (event) => {
      write({ event, final: true });
    },
    noteStall: checkStall,
  };
}
