import { describe, expect, it } from "vitest";
import { createProgressEmitter, type ProgressCadence, progressCadence } from "./progress.js";

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
