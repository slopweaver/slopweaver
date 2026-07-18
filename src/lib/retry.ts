/**
 * Retry-with-backoff for a transient API failure — the resilience octokit already gives GitHub, brought
 * to the Slack + Linear transports (a raw `fetch`/GraphQL call has none). Retries a transient class only:
 * HTTP 429/500/502/503/504, network errors (ECONNRESET/ETIMEDOUT/ENOTFOUND/EAI_AGAIN), and a `fetch
 * failed`; a permanent error (any other 4xx, a GraphQL validation error) fails fast. On a 429 the
 * `Retry-After` is honoured; otherwise the delay grows exponentially (capped). After the attempt budget
 * is spent it gives up LOUDLY — the original error is rethrown, so the caller surfaces it as `err`.
 *
 * The clock/sleep are injected so a test proves the pacing with a fake clock and never actually waits.
 */

/** A retryable status (429 rate-limit + the transient 5xx family). */
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

/** Default classification: is this error worth retrying? */
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

/** The `Retry-After` delay (ms) an error asks for — Slack's `.retryAfter` (s) or a `retry-after` header. */
export function retryAfterMs({ error }: { error: unknown }): number | undefined {
  const slack = prop({ error, key: "retryAfter" });
  if (typeof slack === "number" && slack >= 0) {
    return Math.ceil(slack * 1000);
  }
  const headers = prop({ error: prop({ error, key: "response" }), key: "headers" });
  const header =
    typeof headers === "object" && headers !== null ? (headers as Record<string, unknown>)["retry-after"] : undefined;
  const seconds = typeof header === "string" ? Number(header) : undefined;
  return seconds !== undefined && Number.isFinite(seconds) && seconds >= 0 ? Math.ceil(seconds * 1000) : undefined;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Tuning + injected seams for {@link retry}. */
export interface RetryOptions {
  /** Total attempts including the first (defaults to 4). */
  readonly maxAttempts?: number;
  /** First backoff delay in ms; doubles each retry (defaults to 500). */
  readonly baseDelayMs?: number;
  /** Backoff ceiling in ms (defaults to 30s). */
  readonly maxDelayMs?: number;
  /** Override the transient classification. */
  readonly isRetryable?: (error: unknown) => boolean;
  /** Injected sleep (a fake advances virtual time in tests). */
  readonly sleep?: (ms: number) => Promise<void>;
  /** A label for the exhausted-budget message context. */
  readonly label?: string;
}

/**
 * Run `operation`, retrying a transient failure with backoff (Retry-After honoured) up to the attempt
 * budget, then rethrowing the last error.
 *
 * @param operation the async call to run + retry
 * @param options tuning + injected sleep/classifier
 * @returns the operation's result
 */
export async function retry<T>({
  operation,
  maxAttempts = 4,
  baseDelayMs = 500,
  maxDelayMs = 30_000,
  isRetryable = (error) => isTransientError({ error }),
  sleep = realSleep,
}: { operation: () => Promise<T> } & RetryOptions): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error: unknown) {
      if (attempt >= maxAttempts || !isRetryable(error)) {
        throw error; // give up loudly — the caller turns this into `err`
      }
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await sleep(retryAfterMs({ error }) ?? backoff);
    }
  }
}
