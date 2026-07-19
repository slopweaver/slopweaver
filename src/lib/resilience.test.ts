import { describe, expect, it } from "vitest";
import { createConcurrencyLimiter, createRateScheduler, isTransientError, retryTransient } from "./resilience.js";

/** A deferred promise handle, so a test controls exactly when a task resolves. */
function defer(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** An `Error` carrying an HTTP `status` — the shape a real SDK throws (p-retry only accepts Errors). */
function httpError({ status }: { status: number }): Error {
  return Object.assign(new Error(`HTTP ${String(status)}`), { status });
}

describe("isTransientError", () => {
  it("treats a 429 and the transient 5xx family as retryable", () => {
    expect(isTransientError({ error: { status: 429 } })).toBe(true);
    expect(isTransientError({ error: { status: 500 } })).toBe(true);
    expect(isTransientError({ error: { statusCode: 503 } })).toBe(true);
    expect(isTransientError({ error: { response: { status: 502 } } })).toBe(true);
  });

  it("treats a known network error code and a `fetch failed` message as retryable", () => {
    expect(isTransientError({ error: { code: "ECONNRESET" } })).toBe(true);
    expect(isTransientError({ error: new Error("fetch failed") })).toBe(true);
  });

  it("treats any other 4xx / validation error as permanent", () => {
    expect(isTransientError({ error: { status: 400 } })).toBe(false);
    expect(isTransientError({ error: { status: 404 } })).toBe(false);
    expect(isTransientError({ error: new Error("bad query") })).toBe(false);
  });
});

describe("retryTransient", () => {
  it("self-heals: retries a transient failure then returns the eventual success", async () => {
    let attempts = 0;
    const value = await retryTransient({
      operation: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw httpError({ status: 500 });
        }
        return "ok";
      },
      policy: { minTimeoutMs: 0 },
    });
    expect(value).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("fails fast on a permanent error — one attempt, no retries", async () => {
    let attempts = 0;
    await expect(
      retryTransient({
        operation: async () => {
          attempts += 1;
          throw httpError({ status: 400 });
        },
        policy: { minTimeoutMs: 0 },
      }),
    ).rejects.toMatchObject({ status: 400 });
    expect(attempts).toBe(1);
  });

  it("gives up after the retry budget on a persistent transient error", async () => {
    let attempts = 0;
    await expect(
      retryTransient({
        operation: async () => {
          attempts += 1;
          throw httpError({ status: 503 });
        },
        policy: { minTimeoutMs: 0, retries: 2 },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(attempts).toBe(3); // first attempt + 2 retries
  });
});

describe("createConcurrencyLimiter", () => {
  it("never runs more than `concurrency` tasks at once", async () => {
    const limit = createConcurrencyLimiter({ concurrency: 2 });
    const gates = [defer(), defer(), defer(), defer()];
    let running = 0;
    let peak = 0;
    const run = (i: number): Promise<void> =>
      limit(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await gates[i]!.promise;
        running -= 1;
      });
    const all = [run(0), run(1), run(2), run(3)];
    for (const g of gates) {
      g.resolve();
    }
    await Promise.all(all);
    // Four tasks, cap of 2: the max simultaneously-running never exceeds — and reaches — 2.
    expect(peak).toBe(2);
  });
});

describe("createRateScheduler", () => {
  it("runs each scheduled task and returns its own result, in order", async () => {
    const schedule = createRateScheduler({ ratePerSec: 1000 });
    const results = await Promise.all([
      schedule(async () => "a"),
      schedule(async () => "b"),
      schedule(async () => "c"),
    ]);
    expect(results).toEqual(["a", "b", "c"]);
  });
});
