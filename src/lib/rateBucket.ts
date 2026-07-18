/**
 * A continuously-refilling token bucket — a shared rate gate every request passes through. Some APIs
 * (Notion: ~3 req/s on every tier, and one recursive page is 100+ calls) are constrained not by
 * parallelism but by a global request rate, so the fix is ONE bucket `take()`-en before each call.
 *
 * Continuous (not windowed) refill: tokens accrue at `ratePerSec` up to `capacity`, so a burst drains
 * the bucket then every later `take()` paces to the steady rate — no busy-spin, no fixed sleep that
 * over/under-shoots. Waiters are serialised through an internal promise chain so two concurrent
 * `take()`s never claim the same refilled token (which would let a fan-out exceed the rate). The clock
 * + sleep are injected so pacing is deterministic under test; production uses wall time.
 *
 * Pure of any API knowledge — it gates calls of any shape, so a fetch seam stays the only API-aware code.
 */

/** Injected timing seams + tuning for a {@link RateBucket}. */
export interface RateBucketOptions {
  /** Sustained requests per second. */
  readonly ratePerSec: number;
  /** Max tokens that can accrue (burst depth); defaults to one second's worth (`ratePerSec`). */
  readonly capacity?: number;
  /** Monotonic clock in ms (defaults to `Date.now`); a fake makes pacing deterministic in tests. */
  readonly now?: () => number;
  /** Sleep (defaults to a real timer); a fake lets a test advance virtual time without waiting. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A continuously-refilling token bucket. Construct ONE per crawl and share it across every fetch so the
 * rate ceiling is global; call `await bucket.take()` immediately before each request.
 */
export class RateBucket {
  private readonly ratePerSec: number;
  private readonly capacity: number;
  private readonly clock: () => number;
  private readonly sleeper: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillMs: number;
  /** Serialises waiters so concurrent `take()`s each wait their turn rather than racing for a token. */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: RateBucketOptions) {
    this.ratePerSec = options.ratePerSec;
    this.capacity = options.capacity ?? options.ratePerSec;
    this.clock = options.now ?? Date.now;
    this.sleeper = options.sleep ?? realSleep;
    this.tokens = this.capacity;
    this.lastRefillMs = this.clock();
  }

  /** Refill tokens for the time elapsed since the last refill, capped at `capacity`. */
  private refill(): void {
    const nowMs = this.clock();
    const elapsedSec = Math.max(0, (nowMs - this.lastRefillMs) / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSec * this.ratePerSec);
    this.lastRefillMs = nowMs;
  }

  /**
   * Acquire one token, waiting exactly long enough if the bucket is empty. Serialised through an
   * internal chain so concurrent callers each wait their turn.
   *
   * @returns a promise that resolves once a token has been consumed
   */
  async take(): Promise<void> {
    const next = this.chain.then(() => this.acquire());
    this.chain = next.catch(() => undefined); // keep the chain alive even if one acquire rejects
    return next;
  }

  private async acquire(): Promise<void> {
    this.refill();
    if (this.tokens < 1) {
      const deficit = 1 - this.tokens;
      await this.sleeper(Math.ceil((deficit / this.ratePerSec) * 1000));
      this.refill();
    }
    this.tokens -= 1;
  }
}
