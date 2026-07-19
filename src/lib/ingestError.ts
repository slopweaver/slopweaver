/**
 * The one typed error the ingest/retrieval boundaries speak. Every external throw — an SDK 429, a
 * network ECONNRESET, a `JSON.parse` SyntaxError, a filesystem ENOENT, an `claude` timeout — is mapped by
 * {@link toIngestError} into this small discriminated union, PRESERVING the status/code/retry-after/cause
 * that the old boolean `isTransientError` flattened away. `cause` is the original thrown value verbatim
 * (identity kept), so nothing is lost on the way to a typed `Result`.
 *
 * Pure module — no I/O, no throwing. The `safe*` wrappers ({@link ../lib/safeBoundary}) call it at each
 * boundary; {@link ../lib/resilience} classifies the typed error for retry; the connectors format it back
 * into their warning/error strings via {@link formatIngestError} / {@link legacyErrorMessages}, so the
 * fatal-vs-warning policy is unchanged.
 */

/**
 * Which boundary a failure arose at. `rate-limit`/`network` are HTTP refinements a retry can clear;
 * `http` is any other HTTP status; `parse` is a malformed-response/JSON failure; `io` is a filesystem
 * failure; `llm` is a model call — the `claude` transport OR the on-device embedder (both are inference
 * calls with no network status to key on).
 */
export type IngestErrorKind = "http" | "rate-limit" | "network" | "parse" | "io" | "llm";

/** A typed boundary failure. Optional fields are present only when the source error carried them. */
export interface IngestError {
  readonly kind: IngestErrorKind;
  /** The boundary operation, e.g. `slack.conversations.history` or `writeJsonFile`. */
  readonly operation: string;
  readonly message: string;
  /** The external system, e.g. `slack`/`linear`/`notion`/`claude`/`embed` (absent for pure fs/parse). */
  readonly provider?: string;
  /** The filesystem path, for an `io` failure. */
  readonly path?: string;
  /** The HTTP status, when the error carried one. */
  readonly status?: number;
  /** A Node errno (`ENOENT`) or SDK string code (`ratelimited`), when present. */
  readonly code?: string;
  /** A parsed `Retry-After` hint in ms, when the error/response exposed one. */
  readonly retryAfterMs?: number;
  /** The original thrown value, verbatim (identity preserved). */
  readonly cause?: unknown;
}

/** Node network error codes a retry can plausibly clear. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
]);
/** SDK string codes that mean "rate limited" (Slack's `ratelimited`, common `rate_limited`). */
const RATE_LIMIT_CODES: ReadonlySet<string> = new Set(["ratelimited", "rate_limited"]);
/** Retryable HTTP statuses (429 rate-limit + the transient 5xx family). */
const TRANSIENT_STATUS: ReadonlySet<number> = new Set([429, 500, 502, 503, 504]);

/** Read a property off an unknown error object without asserting its shape. */
function readProp({ value, key }: { value: unknown; key: string }): unknown {
  return typeof value === "object" && value !== null && key in value
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The HTTP status carried by an error (`.status` / `.statusCode` / `.response.status`), if any. */
function statusOf({ error }: { error: unknown }): number | undefined {
  const direct = readProp({ key: "status", value: error }) ?? readProp({ key: "statusCode", value: error });
  if (typeof direct === "number") {
    return direct;
  }
  const response = readProp({ key: "response", value: error });
  const nested = readProp({ key: "status", value: response });
  return typeof nested === "number" ? nested : undefined;
}

/** The string code carried by an error (`.code`), if any. */
function codeOf({ error }: { error: unknown }): string | undefined {
  const code = readProp({ key: "code", value: error });
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

/** A `Retry-After`/`retryAfter` hint (seconds → ms), from the error or its response headers, if present. */
function retryAfterMsOf({ error }: { error: unknown }): number | undefined {
  const direct = readProp({ key: "retryAfter", value: error });
  if (typeof direct === "number" && Number.isFinite(direct)) {
    return Math.round(direct * 1000);
  }
  const headers = readProp({ key: "headers", value: readProp({ key: "response", value: error }) });
  const header = readProp({ key: "retry-after", value: headers });
  const seconds = typeof header === "string" ? Number(header) : typeof header === "number" ? header : NaN;
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : undefined;
}

/** The best human message for an error (`.message` when present, else a stringified fallback). */
function messageOf({ error }: { error: unknown }): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  const message = readProp({ key: "message", value: error });
  if (typeof message === "string" && message.length > 0) {
    return message;
  }
  return typeof error === "string" && error.length > 0 ? error : "unknown error";
}

/** Refine the boundary's default kind using any HTTP/code/message signal the error carried. */
function resolveKind({
  status,
  code,
  message,
  defaultKind,
}: {
  status: number | undefined;
  code: string | undefined;
  message: string;
  defaultKind: IngestErrorKind;
}): IngestErrorKind {
  if (status === 429 || (code !== undefined && RATE_LIMIT_CODES.has(code))) {
    return "rate-limit";
  }
  if (status !== undefined) {
    return "http";
  }
  if (
    (code !== undefined && NETWORK_CODES.has(code)) ||
    /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|fetch failed/i.test(message)
  ) {
    return "network";
  }
  return defaultKind;
}

/**
 * Map ANY thrown value into a typed {@link IngestError}, preserving status/code/retry-after and the
 * original `cause` (identity kept). The boundary supplies `defaultKind` (what the failure IS absent an
 * HTTP/network signal — `io` for a filesystem call, `llm` for a model call, `http` for an API call), and
 * this refines it to `rate-limit`/`http`/`network` when the error carries the signal.
 *
 * @param error the thrown value (any shape)
 * @param operation the boundary operation label (e.g. `slack.conversations.history`)
 * @param provider the external system, when applicable
 * @param path the filesystem path, for an `io` boundary
 * @param defaultKind the boundary's kind absent an HTTP/network signal (defaults to `http`)
 * @returns the typed error
 */
export function toIngestError({
  error,
  operation,
  provider,
  path,
  defaultKind = "http",
}: {
  error: unknown;
  operation: string;
  provider?: string;
  path?: string;
  defaultKind?: IngestErrorKind;
}): IngestError {
  const status = statusOf({ error });
  const code = codeOf({ error });
  const retryAfterMs = retryAfterMsOf({ error });
  const message = messageOf({ error });
  const kind = resolveKind({ code, defaultKind, message, status });
  // Enforce invariants (kind/operation/message/cause) LAST so the extracted optionals can never clobber
  // them — the archive's spread-then-enforce ordering, re-skinned.
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(path !== undefined ? { path } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    cause: error,
    kind,
    message,
    operation,
  };
}

/** The HTTP status of a typed error (or undefined). A named accessor so call-sites don't reach into fields. */
export function errorStatus({ error }: { error: IngestError }): number | undefined {
  return error.status;
}

/** The string code of a typed error (or undefined). */
export function errorCode({ error }: { error: IngestError }): string | undefined {
  return error.code;
}

/** Whether a typed error's HTTP status is one a retry can clear (429 + transient 5xx). */
export function hasTransientStatus({ error }: { error: IngestError }): boolean {
  return error.status !== undefined && TRANSIENT_STATUS.has(error.status);
}

/**
 * Format a typed error into a single human line: `<provider/kind> <operation>[ HTTP <status>]: <message>`.
 * Deterministic — used to render a typed boundary failure back into the connectors' warning/error strings.
 *
 * @param error the typed error
 * @returns the formatted line
 */
export function formatIngestError({ error }: { error: IngestError }): string {
  const label = error.provider ?? error.kind;
  const status = error.status !== undefined ? ` HTTP ${String(error.status)}` : "";
  return `${label} ${error.operation}${status}: ${error.message}`;
}

/**
 * Render a typed error back into a throwable `Error` — the adapter a THROWING seam uses to re-surface a
 * `safe*` failure so the orchestration's existing catch-to-warning policy still runs unchanged. The
 * original `cause` is returned verbatim when it's already an `Error` (so a caller's message assertions,
 * e.g. `not_in_channel`, are byte-identical); otherwise a formatted `Error` carrying the cause.
 *
 * @param error the typed error
 * @returns an `Error` safe to throw (satisfies `only-throw-error`)
 */
export function ingestErrorToThrowable({ error }: { error: IngestError }): Error {
  if (error.cause instanceof Error) {
    return error.cause;
  }
  // A non-Error cause (e.g. a plain `{ status: 429 }` throw): synthesise an Error that CARRIES the typed
  // status/code, so a downstream retry classifier (which re-maps the throwable) still sees a retryable
  // signal instead of a bare generic error.
  const thrown = new Error(formatIngestError({ error }), { cause: error.cause });
  if (error.status !== undefined) {
    Object.assign(thrown, { status: error.status });
  }
  if (error.code !== undefined) {
    Object.assign(thrown, { code: error.code });
  }
  return thrown;
}

/**
 * Bridge a typed error into the `readonly string[]` the repo's warning-bearing {@link Result} carries, so
 * a `safe*` failure slots into an existing `err([...])` call-site without losing the structured detail
 * (it's rendered by {@link formatIngestError}).
 *
 * @param error the typed error
 * @returns a one-element message array
 */
export function legacyErrorMessages({ error }: { error: IngestError }): readonly string[] {
  return [formatIngestError({ error })];
}
