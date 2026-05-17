/**
 * Unit tests for `withTimeout`.
 *
 * Three contracts:
 *   - operation resolves Ok before deadline → returns that Ok
 *   - operation resolves Err before deadline → returns that Err verbatim
 *   - deadline fires first → returns InitTimeoutError with the configured ms
 *
 * Also pins the "no leaked timer" invariant by injecting a counted clearTimeout
 * impl and asserting it was called on the win path. We use real `setTimeout`
 * with short delays (1ms vs 50ms) rather than fake timers because the helper
 * mixes microtask + macrotask scheduling and fake timers around that mix make
 * the test flaky.
 */

import { describe, expect, it, vi } from 'vitest';
import { errAsync, okAsync, ResultAsync } from '@slopweaver/errors';
import { withTimeout } from './with-timeout.ts';

describe('withTimeout', () => {
  it('returns Ok when operation resolves before the deadline', async () => {
    const result = await withTimeout({
      operation: okAsync({ login: 'octocat' }),
      timeoutMs: 50,
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ login: 'octocat' });
    }
  });

  it('returns the underlying Err when operation rejects before the deadline', async () => {
    const result = await withTimeout({
      operation: errAsync({ code: 'GITHUB_API_ERROR', message: 'Bad credentials' }),
      timeoutMs: 50,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('GITHUB_API_ERROR');
      expect(result.error.message).toBe('Bad credentials');
    }
  });

  it('returns INIT_TIMEOUT when the deadline fires first', async () => {
    // A ResultAsync wrapping a Promise that never settles. The deadline must
    // win the race; the underlying promise is intentionally orphaned.
    const neverResolves = ResultAsync.fromSafePromise(
      new Promise<{ login: string }>(() => {
        /* never resolves */
      }),
    );

    const result = await withTimeout({
      operation: neverResolves,
      timeoutMs: 10,
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('INIT_TIMEOUT');
      if (result.error.code === 'INIT_TIMEOUT') {
        expect(result.error.timeoutMs).toBe(10);
      }
    }
  });

  it('clears the timer when the operation wins, so no handle leaks', async () => {
    // Both spies delegate to the real `globalThis.{set,clear}Timeout` so
    // assertion failures here would also mean an actual leaked Node timer,
    // not just a missed callback invocation. The previous shape used a
    // no-op `vi.fn()` for clear, which only proved the injected function
    // was called — not that the underlying handle was actually released.
    const realTimers: Array<ReturnType<typeof globalThis.setTimeout>> = [];
    const setSpy = vi.fn((fn: () => void, ms: number) => {
      const timer = globalThis.setTimeout(fn, ms);
      realTimers.push(timer);
      return timer;
    });
    const clearSpy = vi.fn((timer: Parameters<typeof clearTimeout>[0]) => {
      globalThis.clearTimeout(timer);
    });

    const result = await withTimeout({
      operation: okAsync({ login: 'octocat' }),
      timeoutMs: 50,
      // `setSpy`'s typing doesn't quite line up with `typeof setTimeout`
      // because vi.fn widens overloads, so we cast it explicitly. `clearSpy`
      // (a plain `vi.fn` over a single-arg call) is already assignable to
      // `typeof clearTimeout`.
      setTimeoutImpl: setSpy as unknown as typeof setTimeout,
      clearTimeoutImpl: clearSpy,
    });

    expect(result.isOk()).toBe(true);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
    // The clear call must reference the same handle the timer spy returned —
    // pin the linkage so a future refactor that "cleared a different timer"
    // would fail this test instead of silently passing.
    expect(realTimers).toHaveLength(1);
    expect(clearSpy).toHaveBeenCalledWith(realTimers[0]);
  });
});
