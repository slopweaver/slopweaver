/**
 * Race a `ResultAsync` against a deadline. If the operation resolves first,
 * its outcome is returned verbatim (Ok or Err). If the deadline fires first,
 * the returned ResultAsync resolves to `Err<InitTimeoutError>`.
 *
 * The underlying operation is not cancelled — neverthrow's `ResultAsync` is
 * a Promise wrapper, and Promises have no abort. For the init wizard's use
 * case (a single REST call against GitHub / Slack) the orphaned promise
 * burns its socket and exits. If a future caller needs real cancellation,
 * plumb an AbortSignal into the underlying client and signal it from the
 * timeout branch.
 *
 * The timer handle is cleared whenever the operation wins, so this helper
 * never leaks a pending timer into the event loop.
 */

import { err, errAsync, okAsync, type Result, ResultAsync } from '@slopweaver/errors';
import type { BaseError } from '@slopweaver/errors';
import { type InitTimeoutError, InitErrors } from './errors.ts';

export type WithTimeoutArgs<T, E extends BaseError> = {
  operation: ResultAsync<T, E>;
  timeoutMs: number;
  setTimeoutImpl?: typeof setTimeout;
  clearTimeoutImpl?: typeof clearTimeout;
};

export function withTimeout<T, E extends BaseError>({
  operation,
  timeoutMs,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
}: WithTimeoutArgs<T, E>): ResultAsync<T, E | InitTimeoutError> {
  const racedPromise = new Promise<Result<T, E | InitTimeoutError>>((resolve) => {
    let settled = false;

    const timer = setTimeoutImpl(() => {
      if (settled) return;
      settled = true;
      resolve(err(InitErrors.timeout({ timeoutMs })));
    }, timeoutMs);

    void Promise.resolve(operation).then((result) => {
      if (settled) return;
      settled = true;
      clearTimeoutImpl(timer);
      resolve(result);
    });
  });

  return ResultAsync.fromSafePromise(racedPromise).andThen((result) =>
    result.isOk() ? okAsync(result.value) : errAsync(result.error),
  );
}
