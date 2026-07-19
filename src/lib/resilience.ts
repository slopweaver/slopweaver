/**
 * The resilience layer: thin, injectable seams over battle-tested libraries — replacing the repo's
 * former hand-rolled retry/backoff loop and its rate limiter (D21). The ONE piece we keep ourselves is
 * the pure, API-agnostic transient-error classification ({@link isTransientError}); every timing,
 * backoff, jitter, pacing, and concurrency loop is now delegated to a maintained ESM library:
 *
 * - **retry + backoff + jitter** → `p-retry` (via {@link retryTransient})
 * - **bounded local concurrency** → `p-limit` (via {@link createConcurrencyLimiter})
 * - **in-process API rate pacing** → `p-throttle` (via {@link createRateScheduler})
 *
 * GitHub keeps its own `@octokit/plugin-retry` + `plugin-throttling` (already settled — see STACK.md);
 * these seams cover the Slack/Linear/Notion SDKs and the on-device embed fan-out. Nothing here needs
 * external infra, and no bespoke backoff, rate limiter, or worker pool survives.
 */
import pLimit from "p-limit";
import pRetry from "p-retry";
import pThrottle from "p-throttle";

/** A retryable HTTP status (429 rate-limit + the transient 5xx family). */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);
/** Node network error codes that a retry can clear. */
const TRANSIENT_CODES: ReadonlySet<string> = new Set(["ECONNRESET", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN"]);

/** Read a property off an unknown error object without asserting its shape. */
function prop({ error, key }: { error: unknown; key: string }): unknown {
  return typeof error === "object" && error !== null && key in error
    ? (error as Record<string, unknown>)[key]
    : undefined;
}

/** The HTTP status carried by an error (`.status` / `.statusCode` / `.response.status`), if any. */
function statusOf({ error }: { error: unknown }): number | undefined {
  const direct = prop({ error, key: "status" }) ?? prop({ error, key: "statusCode" });
  if (typeof direct === "number") {
    return direct;
  }
  const response = prop({ error, key: "response" });
  const nested = prop({ error: response, key: "status" });
  return typeof nested === "number" ? nested : undefined;
}

/**
 * Is this error worth retrying? A transient failure (429/5xx, a known network code, or a message that
 * names one) is retryable; any other 4xx / validation error is permanent and fails fast. Pure — no
 * timing, so a test asserts the classification exactly.
 *
 * @param error the thrown value (any shape)
 * @returns true when a retry could plausibly clear the failure
 */
export function isTransientError({ error }: { error: unknown }): boolean {
  const status = statusOf({ error });
  if (status !== undefined && TRANSIENT_STATUS.has(status)) {
    return true;
  }
  const code = prop({ error, key: "code" });
  if (typeof code === "string" && TRANSIENT_CODES.has(code)) {
    return true;
  }
  const message = prop({ error, key: "message" });
  const text = typeof message === "string" ? message : "";
  return /\b(429|500|502|503|504)\b/.test(text) || /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|fetch failed/i.test(text);
}

/** Tuning for {@link retryTransient} — all optional; the defaults suit an API backfill. */
export interface RetryPolicy {
  /** Retries AFTER the first attempt (defaults to 3 ⇒ 4 total tries). */
  readonly retries?: number;
  /** First backoff delay in ms; grows by `factor` each retry (defaults to 500). `0` ⇒ retry immediately. */
  readonly minTimeoutMs?: number;
  /** Backoff ceiling in ms (defaults to 30s). */
  readonly maxTimeoutMs?: number;
  /** Override the transient classification (defaults to {@link isTransientError}). */
  readonly isRetryable?: (error: unknown) => boolean;
}

/**
 * Run `operation`, retrying only a transient failure with exponential backoff + jitter (via `p-retry`),
 * then rejecting with the last error. A permanent failure rejects on the first attempt.
 *
 * @param operation the async call to run + retry
 * @param policy retry tuning + classification override (tests pass `minTimeoutMs: 0` to avoid waiting)
 * @returns the operation's result
 */
export async function retryTransient<T>({
  operation,
  policy = {},
}: {
  operation: () => Promise<T>;
  policy?: RetryPolicy;
}): Promise<T> {
  const isRetryable = policy.isRetryable ?? ((error: unknown) => isTransientError({ error }));
  return pRetry(operation, {
    factor: 2,
    maxTimeout: policy.maxTimeoutMs ?? 30_000,
    minTimeout: policy.minTimeoutMs ?? 500,
    randomize: true,
    retries: policy.retries ?? 3,
    shouldRetry: ({ error }) => isRetryable(error),
  });
}

/** Runs a task under a shared concurrency cap; returns the task's own result. */
export type ConcurrencyLimiter = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * A bounded-concurrency runner (via `p-limit`): at most `concurrency` tasks run at once, the rest queue.
 * Construct ONE and share it across a fan-out so the ceiling is global.
 *
 * @param concurrency the maximum number of tasks allowed to run simultaneously
 * @returns a runner that schedules a task under the shared cap
 */
export function createConcurrencyLimiter({ concurrency }: { concurrency: number }): ConcurrencyLimiter {
  const limit = pLimit(concurrency);
  return (task) => limit(task);
}

/** Runs a task under a shared rate gate; returns the task's own result. */
export type RateScheduler = <T>(task: () => Promise<T>) => Promise<T>;

/**
 * An in-process rate gate (via `p-throttle`, strict mode): calls are spaced so no more than `ratePerSec`
 * run per second, evenly. Construct ONE per crawl and route every request through it so a big recursive
 * fan-out never self-429s. No external infra.
 *
 * @param ratePerSec the sustained requests-per-second ceiling
 * @returns a scheduler that paces a task under the shared rate
 */
export function createRateScheduler({ ratePerSec }: { ratePerSec: number }): RateScheduler {
  const interval = Math.max(1, Math.round(1000 / ratePerSec));
  const throttle = pThrottle({ interval, limit: 1, strict: true });
  // One shared throttled runner: p-throttle paces the calls to `run`; each invocation just executes the
  // task. The caller's own return type is carried by the RateScheduler generic (the runner is `unknown`).
  const run = throttle((task: () => Promise<unknown>) => task());
  return <T>(task: () => Promise<T>): Promise<T> => run(task) as Promise<T>;
}
