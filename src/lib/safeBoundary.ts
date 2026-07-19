/**
 * The `safe*` boundary wrappers — the ONE sanctioned place an external call is made. Each catches EVERY
 * thrown value (transient or not, async or sync) and maps it to a typed {@link IngestError} via
 * {@link toIngestError}, so no boundary needs a raw `try/catch` and no error detail (status/code/cause) is
 * lost. The boundary dev-lint gate ({@link ../devLint/boundaryResidue}) allowlists this file and forbids a
 * raw boundary call anywhere else.
 *
 * The async wrappers use neverthrow's `ResultAsync.fromPromise(Promise.resolve().then(execute), map)`: the
 * `Promise.resolve().then(execute)` wrapper is deliberate — it captures a SYNCHRONOUS throw from `execute`
 * as a rejected promise too (the archive's idiom, re-skinned). The sync {@link safeFs} owns the only
 * `try/catch` in the module (a sync call can't be a promise), which is why the gate allowlists this file.
 */
import { ResultAsync } from "neverthrow";

import { type IngestError, ingestErrorToThrowable, toIngestError } from "./ingestError.js";
import { type TypedResult, type TypedResultAsync, typedErr, typedOk } from "./result.js";

/**
 * Unwrap a typed result, or re-throw its error as a throwable `Error`. The adapter a THROWING seam uses:
 * the SDK call is wrapped in {@link safeApiCall} (typed), then a fatal failure is re-surfaced as a throw
 * so the connector's existing catch-to-warning/fatal policy runs unchanged — behaviour-preserving.
 *
 * @param result the typed result to unwrap
 * @returns the success value (throws {@link ingestErrorToThrowable} on error)
 */
export function orThrow<T>({ result }: { result: TypedResult<T, IngestError> }): T {
  if (result.isErr()) {
    throw ingestErrorToThrowable({ error: result.error });
  }
  return result.value;
}

/**
 * Wrap an external API/SDK call (Slack/Linear/Notion/GitHub). A throw becomes a typed `http`/`rate-limit`/
 * `network` error (refined from the thrown status/code), never a bare rejection.
 *
 * @param execute the API call to run (may throw synchronously or reject)
 * @param operation the operation label (e.g. `slack.conversations.history`)
 * @param provider the external system (e.g. `slack`)
 * @returns a typed result — the call's value, or the mapped error
 */
export function safeApiCall<T>({
  execute,
  operation,
  provider,
}: {
  execute: () => Promise<T> | T;
  operation: string;
  provider: string;
}): TypedResultAsync<T, IngestError> {
  return ResultAsync.fromPromise(Promise.resolve().then(execute), (error) =>
    toIngestError({ defaultKind: "http", error, operation, provider }),
  );
}

/**
 * Wrap the `claude` LLM transport call. A throw (spawn/timeout/non-zero exit/bad envelope) becomes a typed
 * `llm` error (or a `network` one if it carried a network signal).
 *
 * @param execute the LLM call to run
 * @param operation the operation label (e.g. `claude.complete`)
 * @returns a typed result
 */
export function safeLlm<T>({
  execute,
  operation,
}: {
  execute: () => Promise<T> | T;
  operation: string;
}): TypedResultAsync<T, IngestError> {
  return ResultAsync.fromPromise(Promise.resolve().then(execute), (error) =>
    toIngestError({ defaultKind: "llm", error, operation, provider: "claude" }),
  );
}

/**
 * Wrap an on-device embedder call. A throw (missing binding, tensor mismatch) becomes a typed `llm` error
 * (the embedder is a local model call — see {@link IngestError}'s `llm` kind).
 *
 * @param execute the embed call to run
 * @param operation the operation label (e.g. `embed.embedDocuments`)
 * @returns a typed result
 */
export function safeEmbed<T>({
  execute,
  operation,
}: {
  execute: () => Promise<T> | T;
  operation: string;
}): TypedResultAsync<T, IngestError> {
  return ResultAsync.fromPromise(Promise.resolve().then(execute), (error) =>
    toIngestError({ defaultKind: "llm", error, operation, provider: "embed" }),
  );
}

/**
 * Wrap an ASYNC filesystem call. A throw becomes a typed `io` error carrying the errno `code` and `path`.
 *
 * @param execute the async fs call to run
 * @param operation the operation label (e.g. `appendVectorRows`)
 * @param path the filesystem path (for the typed error)
 * @returns a typed result
 */
export function safeFsAsync<T>({
  execute,
  operation,
  path,
}: {
  execute: () => Promise<T> | T;
  operation: string;
  path?: string;
}): TypedResultAsync<T, IngestError> {
  return ResultAsync.fromPromise(Promise.resolve().then(execute), (error) =>
    toIngestError({ defaultKind: "io", error, operation, ...(path !== undefined ? { path } : {}) }),
  );
}

/**
 * Wrap a SYNCHRONOUS filesystem call → a typed result (no promise). The only `try/catch` in the module,
 * because a sync call can't be modelled as a rejected promise; the boundary gate allowlists this file.
 *
 * @param execute the sync fs call to run
 * @param operation the operation label (e.g. `writeJsonFile`)
 * @param path the filesystem path (for the typed error)
 * @returns a typed result
 */
export function safeFs<T>({
  execute,
  operation,
  path,
}: {
  execute: () => T;
  operation: string;
  path?: string;
}): TypedResult<T, IngestError> {
  try {
    return typedOk(execute());
  } catch (error: unknown) {
    return typedErr(toIngestError({ defaultKind: "io", error, operation, ...(path !== undefined ? { path } : {}) }));
  }
}
