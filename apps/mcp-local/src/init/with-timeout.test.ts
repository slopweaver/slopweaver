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
    const clearSpy = vi.fn();
    const setSpy = vi.fn((fn: () => void, ms: number) => globalThis.setTimeout(fn, ms));

    const result = await withTimeout({
      operation: okAsync({ login: 'octocat' }),
      timeoutMs: 50,
      // Cast: vi.fn signatures don't perfectly line up with `typeof setTimeout`,
      // but the runtime contract holds.
      setTimeoutImpl: setSpy as unknown as typeof setTimeout,
      clearTimeoutImpl: clearSpy as unknown as typeof clearTimeout,
    });

    expect(result.isOk()).toBe(true);
    expect(setSpy).toHaveBeenCalledTimes(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});
