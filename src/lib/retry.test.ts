import { describe, expect, it } from "vitest";
import { isTransientError, retry, retryAfterMs } from "./retry.js";

/** A sleep that records the requested delays instead of waiting. */
function fakeSleep(): { sleep: (ms: number) => Promise<void>; sleeps: number[] } {
  const sleeps: number[] = [];
  return { sleep: async (ms: number) => void sleeps.push(ms), sleeps };
}

describe("isTransientError", () => {
  it("retries 5xx / 429 statuses and network codes, not other 4xx", () => {
    expect(isTransientError({ error: { status: 503 } })).toBe(true);
    expect(isTransientError({ error: { response: { status: 429 } } })).toBe(true);
    expect(isTransientError({ error: { code: "ECONNRESET" } })).toBe(true);
    expect(isTransientError({ error: new Error("GraphQL Error (Code: 503)") })).toBe(true);
    expect(isTransientError({ error: { status: 400 } })).toBe(false);
    expect(isTransientError({ error: new Error("invalid query") })).toBe(false);
  });
});

describe("retryAfterMs", () => {
  it("reads Slack's `.retryAfter` (seconds) and a `retry-after` header", () => {
    expect(retryAfterMs({ error: { retryAfter: 2 } })).toBe(2000);
    expect(retryAfterMs({ error: { response: { headers: { "retry-after": "3" } } } })).toBe(3000);
    expect(retryAfterMs({ error: new Error("nope") })).toBeUndefined();
  });
});

describe("retry", () => {
  it("returns after a transient failure clears (exponential backoff)", async () => {
    const time = fakeSleep();
    let calls = 0;
    const result = await retry({
      baseDelayMs: 100,
      operation: async () => {
        calls += 1;
        if (calls < 3) {
          throw { status: 503 };
        }
        return "ok";
      },
      sleep: time.sleep,
    });
    expect(result).toBe("ok");
    expect(calls).toBe(3);
    expect(time.sleeps).toEqual([100, 200]); // 2 backoffs before the 3rd attempt succeeds
  });

  it("gives up loudly after the attempt budget, rethrowing the last error", async () => {
    const time = fakeSleep();
    let calls = 0;
    await expect(
      retry({
        maxAttempts: 3,
        operation: async () => {
          calls += 1;
          throw new Error("503 unavailable");
        },
        sleep: time.sleep,
      }),
    ).rejects.toThrow("503 unavailable");
    expect(calls).toBe(3);
  });

  it("does not retry a permanent (4xx) error", async () => {
    const time = fakeSleep();
    let calls = 0;
    await expect(
      retry({
        operation: async () => {
          calls += 1;
          throw { status: 400 };
        },
        sleep: time.sleep,
      }),
    ).rejects.toEqual({ status: 400 });
    expect(calls).toBe(1);
    expect(time.sleeps).toEqual([]);
  });

  it("honours Retry-After over the backoff schedule", async () => {
    const time = fakeSleep();
    let calls = 0;
    await retry({
      operation: async () => {
        calls += 1;
        if (calls < 2) {
          throw { retryAfter: 5, status: 429 };
        }
        return "ok";
      },
      sleep: time.sleep,
    });
    expect(time.sleeps).toEqual([5000]); // waited the server-requested 5s, not the default backoff
  });
});
