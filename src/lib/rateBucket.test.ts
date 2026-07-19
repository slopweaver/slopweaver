import { describe, expect, it } from "vitest";
import { RateBucket } from "./rateBucket.js";

/** A virtual clock + sleep: `sleep(ms)` records the wait and advances the clock by exactly that much. */
function fakeTime(): { now: () => number; sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  let ms = 0;
  const sleeps: number[] = [];
  return {
    now: () => ms,
    sleep: async (waitMs: number) => {
      sleeps.push(waitMs);
      ms += waitMs;
    },
    sleeps,
  };
}

describe("RateBucket", () => {
  it("serves a burst up to capacity without waiting", async () => {
    const time = fakeTime();
    const bucket = new RateBucket({ capacity: 3, now: time.now, ratePerSec: 3, sleep: time.sleep });
    await bucket.take();
    await bucket.take();
    await bucket.take();
    expect(time.sleeps).toEqual([]);
  });

  it("paces to the steady rate once the burst is drained", async () => {
    const time = fakeTime();
    const bucket = new RateBucket({ capacity: 3, now: time.now, ratePerSec: 3, sleep: time.sleep });
    await bucket.take();
    await bucket.take();
    await bucket.take();
    await bucket.take(); // bucket empty → wait 1/3s for one token
    expect(time.sleeps).toEqual([334]);
  });

  it("serialises concurrent takes so a fan-out cannot exceed the rate", async () => {
    const time = fakeTime();
    const bucket = new RateBucket({ capacity: 1, now: time.now, ratePerSec: 1, sleep: time.sleep });
    await Promise.all([bucket.take(), bucket.take(), bucket.take()]);
    // first is free (capacity 1); the next two each wait a full second in turn — not both racing one token
    expect(time.sleeps).toEqual([1000, 1000]);
  });
});
