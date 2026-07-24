import { describe, expect, it } from "vitest";
import {
  collapseProgressPhase,
  createProgressEmitter,
  createRichProgressEmitter,
  DEFAULT_PROGRESS_CONFIG,
  etaSeconds,
  initialProgressState,
  monotonicPercent,
  nextProgressState,
  type ProgressCadence,
  phaseSource,
  progressCadence,
  progressSnapshot,
  type RichProgressEvent,
  shouldEmitProgress,
  stalledSnapshot,
  updateEmaRate,
} from "./progress.js";

/** A fake clock whose value the test advances between emits. */
function fakeClock(): { now: () => number; set: (t: number) => void } {
  let t = 0;
  return {
    now: () => t,
    set: (v) => {
      t = v;
    },
  };
}

/** A heartbeat event with the given fields (keeps the pure-model tests terse). */
function heartbeat(fields: Omit<RichProgressEvent, "lane">): RichProgressEvent {
  return { lane: "heartbeat", ...fields };
}

/** Parse the captured JSON progress lines into objects, for exact assertions. */
function parse({ lines }: { lines: readonly string[] }): readonly Record<string, unknown>[] {
  return lines.map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("progressCadence (pure)", () => {
  it("emits ~10 milestone lines for a small job (time gate off)", () => {
    expect(progressCadence({ total: 50 })).toEqual({ milestoneEvery: 5, minIntervalMs: 0 });
    expect(progressCadence({ total: 200 })).toEqual({ milestoneEvery: 20, minIntervalMs: 0 });
  });

  it("emits ~once/minute for a normal job (milestone gate off)", () => {
    expect(progressCadence({ total: 1000 })).toEqual({ milestoneEvery: 0, minIntervalMs: 60_000 });
  });

  it("backs off to ~once/5-minutes for a large job", () => {
    expect(progressCadence({ total: 30_000 })).toEqual({ milestoneEvery: 0, minIntervalMs: 300_000 });
  });
});

describe("createProgressEmitter", () => {
  it("always emits the first update, stamped with verb/phase/counts/elapsed", () => {
    const lines: string[] = [];
    let t = 1000;
    const emitter = createProgressEmitter({ now: () => t, sink: (l) => lines.push(l), verb: "distil" });
    t = 1500;
    emitter.update({ counts: { cached: 7, called: 5 }, done: 12, phase: "batch", total: 80 });
    expect(parse({ lines })).toEqual([
      {
        cached: 7,
        called: 5,
        done: 12,
        elapsedMs: 500,
        phase: "batch",
        total: 80,
        type: "slopweaver.progress",
        verb: "distil",
      },
    ]);
  });

  it("suppresses between the time gate, then emits once the interval elapses", () => {
    const lines: string[] = [];
    let t = 0;
    const cadence: ProgressCadence = { milestoneEvery: 0, minIntervalMs: 60_000 };
    const emitter = createProgressEmitter({ cadence, now: () => t, sink: (l) => lines.push(l), verb: "embed" });
    emitter.update({ done: 1, phase: "chunk", total: 1000 }); // first — always emits
    t = 1000;
    emitter.update({ done: 2, phase: "chunk", total: 1000 }); // +1s — suppressed
    t = 61_000;
    emitter.update({ done: 900, phase: "chunk", total: 1000 }); // +61s — emits
    expect(parse({ lines }).map((l) => l["done"])).toEqual([1, 900]);
  });

  it("emits only on milestones for a small job (plus the guaranteed first)", () => {
    const lines: string[] = [];
    const cadence: ProgressCadence = { milestoneEvery: 5, minIntervalMs: 0 };
    const emitter = createProgressEmitter({ cadence, now: () => 0, sink: (l) => lines.push(l), verb: "distil" });
    emitter.update({ done: 1, phase: "batch", total: 50 }); // first — emits
    emitter.update({ done: 3, phase: "batch", total: 50 }); // not a multiple of 5 — suppressed
    emitter.update({ done: 5, phase: "batch", total: 50 }); // multiple of 5 — emits
    expect(parse({ lines }).map((l) => l["done"])).toEqual([1, 5]);
  });

  it("always emits finish, even when the time gate would suppress", () => {
    const lines: string[] = [];
    const cadence: ProgressCadence = { milestoneEvery: 0, minIntervalMs: 60_000 };
    const emitter = createProgressEmitter({ cadence, now: () => 0, sink: (l) => lines.push(l), verb: "distil" });
    emitter.update({ done: 1, phase: "batch", total: 1000 }); // first
    emitter.finish({ done: 1000, phase: "done", total: 1000 }); // forced
    expect(parse({ lines }).map((l) => l["phase"])).toEqual(["batch", "done"]);
  });

  it("is non-blocking: the sink is called synchronously and update returns void", () => {
    const lines: string[] = [];
    const emitter = createProgressEmitter({ now: () => 0, sink: (l) => lines.push(l), verb: "refresh" });
    const returned = emitter.update({ done: 1, phase: "source", total: 10 });
    expect(returned).toBeUndefined(); // no promise — nothing to await
    expect(lines.length).toBe(1); // already written by the time update() returned
  });
});

describe("monotonicPercent (pure)", () => {
  it("hides the percent until BOTH done and total are positive", () => {
    expect(monotonicPercent({ done: 0, previous: undefined, total: 100 })).toBeUndefined();
    expect(monotonicPercent({ done: 5, previous: undefined, total: 0 })).toBeUndefined();
    expect(monotonicPercent({ done: undefined, previous: undefined, total: 100 })).toBeUndefined();
  });

  it("floors done/total and clamps to 100", () => {
    expect(monotonicPercent({ done: 1, previous: undefined, total: 3 })).toBe(33);
    expect(monotonicPercent({ done: 999, previous: undefined, total: 10 })).toBe(100);
  });

  it("never goes backwards — a smaller later ratio keeps the previous percent", () => {
    expect(monotonicPercent({ done: 2, previous: 63, total: 100 })).toBe(63);
  });
});

describe("updateEmaRate + etaSeconds (pure)", () => {
  it("seeds on the first sample, then smooths with alpha 0.25", () => {
    const first = updateEmaRate({ alpha: 0.25, doneDelta: 10, elapsedMs: 1000, previousRate: undefined });
    expect(first).toBe(10); // 10 items / 1s
    const second = updateEmaRate({ alpha: 0.25, doneDelta: 20, elapsedMs: 1000, previousRate: 10 });
    expect(second).toBe(12.5); // 0.25*20 + 0.75*10
  });

  it("carries the previous rate when a sample has no signal (zero delta or elapsed)", () => {
    expect(updateEmaRate({ alpha: 0.25, doneDelta: 0, elapsedMs: 1000, previousRate: 7 })).toBe(7);
    expect(updateEmaRate({ alpha: 0.25, doneDelta: 5, elapsedMs: 0, previousRate: 7 })).toBe(7);
  });

  it("etaSeconds divides remaining by rate, and hides when the rate is unusable", () => {
    expect(etaSeconds({ rate: 10, remaining: 200 })).toBe(20);
    expect(etaSeconds({ rate: undefined, remaining: 200 })).toBeUndefined();
    expect(etaSeconds({ rate: 10, remaining: 0 })).toBeUndefined();
  });
});

describe("collapseProgressPhase + phaseSource (pure)", () => {
  it("maps known phases to human steps and title-cases unknown ones", () => {
    expect(collapseProgressPhase({ phase: "slack.channel", verb: "refresh" })).toBe("Reading channel");
    expect(collapseProgressPhase({ phase: "batch", verb: "distil" })).toBe("Distilling batches");
    expect(collapseProgressPhase({ phase: "some-new-phase", verb: "refresh" })).toBe("Some new phase");
  });

  it("extracts the source token only for the four known sources", () => {
    expect(phaseSource({ phase: "slack.channel" })).toBe("slack");
    expect(phaseSource({ phase: "github.repos" })).toBe("github");
    expect(phaseSource({ phase: "batch" })).toBeUndefined();
    expect(phaseSource({ phase: "members" })).toBeUndefined();
  });
});

describe("nextProgressState (pure)", () => {
  it("shows the ETA only after two real forward deltas (no early jitter)", () => {
    const s0 = initialProgressState({ startMs: 0, verb: "refresh" });
    const s1 = nextProgressState({
      config: DEFAULT_PROGRESS_CONFIG,
      event: heartbeat({ done: 10, phase: "slack.channel", total: 100 }),
      nowMs: 1000,
      state: s0,
    });
    expect(progressSnapshot({ nowMs: 1000, stalled: false, state: s1 }).etaSeconds).toBeUndefined();
    const s2 = nextProgressState({
      config: DEFAULT_PROGRESS_CONFIG,
      event: heartbeat({ done: 20, phase: "slack.channel", total: 100 }),
      nowMs: 2000,
      state: s1,
    });
    const snap = progressSnapshot({ nowMs: 2000, stalled: false, state: s2 });
    expect(snap.percent).toBe(20);
    expect(snap.etaSeconds).toBe(8); // ~10 items/s, 80 remaining
    expect(snap.step).toBe("Reading channel");
    expect(snap.source).toBe("slack");
  });

  it("REPLACES metrics per event (no cross-source bleed) and keeps the last currentItem", () => {
    const s0 = initialProgressState({ startMs: 0, verb: "refresh" });
    const s1 = nextProgressState({
      config: DEFAULT_PROGRESS_CONFIG,
      event: heartbeat({ currentItem: { title: "acme/api" }, metrics: { records: 918 }, phase: "github.repos" }),
      nowMs: 1000,
      state: s0,
    });
    const s2 = nextProgressState({
      config: DEFAULT_PROGRESS_CONFIG,
      event: heartbeat({ currentItem: { title: "#eng" }, metrics: { messages: 12 }, phase: "slack.channel" }),
      nowMs: 2000,
      state: s1,
    });
    expect(s2.metrics).toEqual({ messages: 12 }); // github `records` does NOT bleed onto the slack line
    expect(s2.currentItem).toEqual({ title: "#eng" });
    // A metric-less event (a "starting" heartbeat) clears the metrics clause rather than showing stale ones.
    const s3 = nextProgressState({
      config: DEFAULT_PROGRESS_CONFIG,
      event: heartbeat({ phase: "slack.channel" }),
      nowMs: 3000,
      state: s2,
    });
    expect(s3.metrics).toEqual({});
  });

  it("resets percent/rate on a PHASE change so a smaller later phase isn't frozen (no --all-sources contamination)", () => {
    const config = DEFAULT_PROGRESS_CONFIG;
    // Phase A (a big source) climbs to ~95%.
    let s = initialProgressState({ startMs: 0, verb: "refresh" });
    s = nextProgressState({
      config,
      event: heartbeat({ done: 20, phase: "github.repos", total: 42 }),
      nowMs: 1000,
      state: s,
    });
    s = nextProgressState({
      config,
      event: heartbeat({ done: 40, phase: "github.repos", total: 42 }),
      nowMs: 2000,
      state: s,
    });
    expect(progressSnapshot({ nowMs: 2000, stalled: false, state: s }).percent).toBe(95);
    // Phase B (a smaller source) starts fresh — its own 33%, not frozen at 95%, ETA re-hidden until 2 deltas.
    s = nextProgressState({
      config,
      event: heartbeat({ done: 4, phase: "slack.channel", total: 12 }),
      nowMs: 3000,
      state: s,
    });
    const snapB = progressSnapshot({ nowMs: 3000, stalled: false, state: s });
    expect(snapB.percent).toBe(33);
    expect(snapB.etaSeconds).toBeUndefined();
    expect(snapB.source).toBe("slack");
  });
});

describe("shouldEmitProgress (pure)", () => {
  it("always emits the first line of a lane and any final line", () => {
    const config = DEFAULT_PROGRESS_CONFIG;
    const s = initialProgressState({ startMs: 0, verb: "refresh" });
    expect(shouldEmitProgress({ config, final: false, lane: "heartbeat", nowMs: 0, state: s })).toBe(true);
    const emitted = { ...s, lastEmitMs: { heartbeat: 0 } };
    expect(shouldEmitProgress({ config, final: false, lane: "heartbeat", nowMs: 1000, state: emitted })).toBe(false);
    expect(shouldEmitProgress({ config, final: true, lane: "heartbeat", nowMs: 1000, state: emitted })).toBe(true);
  });

  it("re-emits a lane only once its own interval has elapsed", () => {
    const config = DEFAULT_PROGRESS_CONFIG;
    const s = { ...initialProgressState({ startMs: 0, verb: "refresh" }), lastEmitMs: { content_preview: 0 } };
    expect(shouldEmitProgress({ config, final: false, lane: "content_preview", nowMs: 19_000, state: s })).toBe(false);
    expect(shouldEmitProgress({ config, final: false, lane: "content_preview", nowMs: 20_000, state: s })).toBe(true);
  });
});

describe("stalledSnapshot (pure)", () => {
  it("fires only once no update has landed for the stall threshold", () => {
    const s = { ...initialProgressState({ startMs: 0, verb: "refresh" }), lastUpdateMs: 1000, phase: "slack.channel" };
    expect(stalledSnapshot({ nowMs: 60_000, stallAfterMs: 60_000, state: s })).toBeUndefined();
    const snap = stalledSnapshot({ nowMs: 61_000, stallAfterMs: 60_000, state: s });
    expect(snap!.stalled).toBe(true);
    expect(snap!.step).toBe("Reading channel");
  });
});

describe("createRichProgressEmitter", () => {
  it("emits a human line to humanSink and a machine JSON line to machineSink for the first heartbeat", () => {
    const clock = fakeClock();
    const human: string[] = [];
    const machine: string[] = [];
    const emitter = createRichProgressEmitter({
      humanSink: (l) => human.push(l),
      machineSink: (l) => machine.push(l),
      now: clock.now,
      verb: "refresh",
    });
    emitter.emit({ done: 10, lane: "heartbeat", metrics: { messages: 12_420 }, phase: "slack.channel", total: 100 });
    expect(human).toEqual(["refresh slack · Reading channel · 10% · 12,420 messages\n"]);
    const parsed = JSON.parse(machine[0]!) as Record<string, unknown>;
    expect(parsed["type"]).toBe("slopweaver.progress");
    expect(parsed["verb"]).toBe("refresh");
    expect(parsed["lane"]).toBe("heartbeat");
  });

  it("throttles a lane within its window, then emits once the interval elapses (final not involved)", () => {
    const clock = fakeClock();
    const human: string[] = [];
    const emitter = createRichProgressEmitter({
      humanSink: (l) => human.push(l),
      machineSink: () => {},
      now: clock.now,
      verb: "refresh",
    });
    emitter.emit({ done: 1, lane: "heartbeat", phase: "slack.channel", total: 100 }); // first — emits
    clock.set(4_000);
    emitter.emit({ done: 2, lane: "heartbeat", phase: "slack.channel", total: 100 }); // +4s — throttled (5s gate)
    clock.set(5_000);
    emitter.emit({ done: 50, lane: "heartbeat", phase: "slack.channel", total: 100 }); // +5s — emits
    expect(human.length).toBe(2);
  });

  it("throttles each lane independently — a preview isn't gated by a recent heartbeat", () => {
    const clock = fakeClock();
    const human: string[] = [];
    const emitter = createRichProgressEmitter({
      humanSink: (l) => human.push(l),
      machineSink: () => {},
      now: clock.now,
      verb: "refresh",
    });
    emitter.emit({ done: 1, lane: "heartbeat", phase: "slack.channel", total: 100 });
    emitter.emit({
      lane: "content_preview",
      phase: "slack.channel",
      preview: { snippet: "hi", sourceContentId: "C1", subject: "#eng" },
    });
    expect(human.length).toBe(2); // both first-of-lane — both emit
    expect(human[1]).toBe('  ↳ #eng · "hi" [C1]\n');
  });

  it("finish() bypasses the throttle even right after a heartbeat", () => {
    const clock = fakeClock();
    const human: string[] = [];
    const emitter = createRichProgressEmitter({
      humanSink: (l) => human.push(l),
      machineSink: () => {},
      now: clock.now,
      verb: "distil",
    });
    emitter.emit({ done: 1, lane: "heartbeat", phase: "batch", total: 100 });
    clock.set(100); // well within the 5s gate
    emitter.finish({ done: 100, lane: "heartbeat", phase: "batch", total: 100 });
    expect(human.length).toBe(2);
    expect(human[1]).toBe("distil · Distilling batches · 100%\n");
  });

  it("is fire-and-forget: a throwing sink never propagates out of emit", () => {
    const emitter = createRichProgressEmitter({
      humanSink: () => {
        throw new Error("broken relay");
      },
      machineSink: () => {},
      now: () => 0,
      verb: "refresh",
    });
    expect(() => emitter.emit({ done: 1, lane: "heartbeat", phase: "slack.channel", total: 10 })).not.toThrow();
  });

  it("noteStall emits a (stalled) heartbeat only after the stall threshold with no update", () => {
    const clock = fakeClock();
    const human: string[] = [];
    const emitter = createRichProgressEmitter({
      humanSink: (l) => human.push(l),
      machineSink: () => {},
      now: clock.now,
      verb: "refresh",
    });
    emitter.emit({ done: 1, lane: "heartbeat", phase: "slack.channel", total: 100 });
    clock.set(30_000);
    emitter.noteStall(); // only 30s since the update — no stall
    clock.set(61_000);
    emitter.noteStall(); // 61s — stall line
    expect(human.length).toBe(2);
    expect(human[1]!.includes("(stalled)")).toBe(true);
  });

  it("wires a provided stallTimer to the watchdog — a tick after the threshold prints a (stalled) line", () => {
    const clock = fakeClock();
    const human: string[] = [];
    let tick: (() => void) | undefined;
    const emitter = createRichProgressEmitter({
      humanSink: (l) => human.push(l),
      machineSink: () => {},
      now: clock.now,
      stallTimer: ({ intervalMs, onTick }) => {
        expect(intervalMs).toBe(60_000); // the locked stall threshold
        tick = onTick;
      },
      verb: "refresh",
    });
    emitter.emit({ done: 1, lane: "heartbeat", phase: "slack.channel", total: 100 });
    clock.set(30_000);
    tick!(); // watchdog fires, but only 30s elapsed — no stall line
    clock.set(61_000);
    tick!(); // now 61s of silence — the watchdog prints the stall line
    expect(human.filter((l) => l.includes("(stalled)")).length).toBe(1);
  });
});
