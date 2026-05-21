/**
 * Slack image-share flow. Drives the same 4-call sequence the Slack web
 * client uses to attach an image to a channel or thread message:
 *
 *   1. `POST <api>/files.getUploadURL`       (user xoxc; returns upload_url + file_id)
 *   2. `POST <upload_url>`                   (binary bytes)
 *   3. `POST <api>/files.completeUpload`     (user xoxc; finalises the file)
 *   4. `POST <api>/files.share`              (user xoxc; SENDS the message + attachment)
 *
 * Step 4 is the actual send. Slack has no draft-with-attachment path;
 * the flow is always upload-then-share. Phase A (text draft for human
 * review) is implemented separately via the Slack MCP, then this
 * function runs Phase B once the human acks.
 *
 * The caller supplies the xoxc token. This function never reads cookies,
 * localStorage, or any other credential store.
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { errAsync, okAsync, ResultAsync } from '@slopweaver/errors';
import { SlackImageErrors, type SlackImageError } from './errors.ts';
import type { SendImageArgs, SendImageResult, SlackImageUploadConfig } from './types.ts';

/**
 * Dependencies injected for testability. Defaults bind to `globalThis.fetch`
 * (Node 22+) and `fs/promises.readFile`. Tests supply mocks.
 */
export type SendImageDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly readImageBytes?: (path: string) => Promise<Buffer>;
};

const XOXC_PREFIX = 'xoxc-';

function isXoxcToken({ token }: { token: string }): boolean {
  return token.startsWith(XOXC_PREFIX);
}

function buildApiUrl({ config, method }: { config: SlackImageUploadConfig; method: string }): string {
  const base = config.apiBaseUrl.replace(/\/+$/, '');
  const url = `${base}/api/${method}`;
  if (config.slackRoute === undefined || config.slackRoute.length === 0) {
    return url;
  }
  return `${url}?slack_route=${encodeURIComponent(config.slackRoute)}`;
}

async function readBodyAsText({ res }: { res: Response }): Promise<string> {
  // `.text()` rejects if the response was already consumed; in this
  // module each response is read exactly once so that case can't fire,
  // but defend against it anyway by swallowing the read error.
  try {
    return await res.text();
  } catch {
    return '';
  }
}

type SlackApiJson = { ok?: boolean; error?: string } & Record<string, unknown>;

async function parseSlackJson({ res }: { res: Response }): Promise<SlackApiJson | null> {
  try {
    const body: unknown = await res.json();
    if (body !== null && typeof body === 'object') {
      return body as SlackApiJson;
    }
    return null;
  } catch {
    return null;
  }
}

type GetUploadUrlResponse = {
  readonly uploadUrl: string;
  readonly fileId: string;
};

function getUploadUrl({
  config,
  fileName,
  byteLength,
  fetchImpl,
}: {
  config: SlackImageUploadConfig;
  fileName: string;
  byteLength: number;
  fetchImpl: typeof fetch;
}): ResultAsync<GetUploadUrlResponse, SlackImageError> {
  const body = new URLSearchParams({
    token: config.token,
    filename: fileName,
    length: String(byteLength),
  });
  return ResultAsync.fromPromise(
    fetchImpl(buildApiUrl({ config, method: 'files.getUploadURL' }), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
    }),
    (e) => SlackImageErrors.uploadUrlFailed({ cause: e instanceof Error ? e.message : String(e) }),
  ).andThen((res) => {
    if (!res.ok) {
      return ResultAsync.fromPromise(readBodyAsText({ res }), () =>
        SlackImageErrors.uploadUrlFailed({ cause: `http ${res.status}` }),
      ).andThen((text) =>
        errAsync<GetUploadUrlResponse, SlackImageError>(
          SlackImageErrors.uploadUrlFailed({ cause: `http ${res.status}: ${text.slice(0, 200)}` }),
        ),
      );
    }
    return ResultAsync.fromPromise(parseSlackJson({ res }), () =>
      SlackImageErrors.uploadUrlFailed({ cause: 'unparseable JSON' }),
    ).andThen((json) => {
      if (json?.ok !== true) {
        return errAsync<GetUploadUrlResponse, SlackImageError>(
          SlackImageErrors.uploadUrlFailed({
            cause: 'slack reported failure',
            ...(typeof json?.error === 'string' ? { slackError: json.error } : {}),
          }),
        );
      }
      const uploadUrl = typeof json['upload_url'] === 'string' ? json['upload_url'] : undefined;
      const fileId = typeof json['file_id'] === 'string' ? json['file_id'] : undefined;
      if (uploadUrl === undefined || fileId === undefined) {
        return errAsync<GetUploadUrlResponse, SlackImageError>(
          SlackImageErrors.uploadUrlFailed({ cause: 'response missing upload_url or file_id' }),
        );
      }
      return okAsync<GetUploadUrlResponse, SlackImageError>({ uploadUrl, fileId });
    });
  });
}

function uploadBytes({
  uploadUrl,
  imageBytes,
  fetchImpl,
}: {
  uploadUrl: string;
  imageBytes: Buffer;
  fetchImpl: typeof fetch;
}): ResultAsync<void, SlackImageError> {
  return ResultAsync.fromPromise(
    fetchImpl(uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream' },
      // Buffer is a valid request body in Node's undici-backed fetch,
      // but the lib.dom typings only declare a subset. Cast to the
      // structural shape `fetch` accepts.
      body: new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength),
    }),
    (e) => SlackImageErrors.bytesUploadFailed({ cause: e instanceof Error ? e.message : String(e) }),
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<void, SlackImageError>(
        SlackImageErrors.bytesUploadFailed({ cause: `http ${res.status}`, httpStatus: res.status }),
      );
    }
    return okAsync<void, SlackImageError>(undefined);
  });
}

function completeUpload({
  config,
  fileId,
  fileName,
  fetchImpl,
}: {
  config: SlackImageUploadConfig;
  fileId: string;
  fileName: string;
  fetchImpl: typeof fetch;
}): ResultAsync<void, SlackImageError> {
  const body = new URLSearchParams({
    token: config.token,
    files: JSON.stringify([{ id: fileId, title: fileName }]),
  });
  return ResultAsync.fromPromise(
    fetchImpl(buildApiUrl({ config, method: 'files.completeUpload' }), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
    }),
    (e) => SlackImageErrors.completeFailed({ cause: e instanceof Error ? e.message : String(e) }),
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<void, SlackImageError>(SlackImageErrors.completeFailed({ cause: `http ${res.status}` }));
    }
    return ResultAsync.fromPromise(parseSlackJson({ res }), () =>
      SlackImageErrors.completeFailed({ cause: 'unparseable JSON' }),
    ).andThen((json) => {
      if (json?.ok !== true) {
        return errAsync<void, SlackImageError>(
          SlackImageErrors.completeFailed({
            cause: 'slack reported failure',
            ...(typeof json?.error === 'string' ? { slackError: json.error } : {}),
          }),
        );
      }
      return okAsync<void, SlackImageError>(undefined);
    });
  });
}

function shareFile({
  config,
  fileId,
  channelId,
  text,
  threadTs,
  fetchImpl,
}: {
  config: SlackImageUploadConfig;
  fileId: string;
  channelId: string;
  text: string;
  threadTs?: string;
  fetchImpl: typeof fetch;
}): ResultAsync<SendImageResult, SlackImageError> {
  const body = new URLSearchParams({
    token: config.token,
    file: fileId,
    channel: channelId,
    text,
    ...(threadTs !== undefined ? { thread_ts: threadTs } : {}),
  });
  return ResultAsync.fromPromise(
    fetchImpl(buildApiUrl({ config, method: 'files.share' }), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' },
      body,
    }),
    (e) => SlackImageErrors.shareFailed({ cause: e instanceof Error ? e.message : String(e) }),
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<SendImageResult, SlackImageError>(SlackImageErrors.shareFailed({ cause: `http ${res.status}` }));
    }
    return ResultAsync.fromPromise(parseSlackJson({ res }), () =>
      SlackImageErrors.shareFailed({ cause: 'unparseable JSON' }),
    ).andThen((json) => {
      if (json?.ok !== true) {
        return errAsync<SendImageResult, SlackImageError>(
          SlackImageErrors.shareFailed({
            cause: 'slack reported failure',
            ...(typeof json?.error === 'string' ? { slackError: json.error } : {}),
          }),
        );
      }
      // `files.share` returns the channel message ts as `ts` at the
      // top level (or nested under `file_msg_ts` depending on which
      // workspace tier the user is on). Accept either.
      const ts =
        typeof json['ts'] === 'string'
          ? json['ts']
          : typeof json['file_msg_ts'] === 'string'
            ? json['file_msg_ts']
            : undefined;
      if (ts === undefined) {
        return errAsync<SendImageResult, SlackImageError>(
          SlackImageErrors.shareFailed({ cause: 'response missing ts / file_msg_ts' }),
        );
      }
      return okAsync<SendImageResult, SlackImageError>({ fileId, fileMsgTs: ts });
    });
  });
}

/**
 * Run the 4-call Slack web-API sequence to share `imagePath` into
 * `channelId` (optionally a thread reply) with `text` as the message
 * body. Returns the resulting file id + channel message timestamp on
 * success, or a typed Result error at any step.
 *
 * The caller is responsible for:
 *   - Providing a valid xoxc token (this function rejects non-xoxc input).
 *   - Voice-linting the text before passing it in (use `apply_voice_rules`).
 *   - Getting human ack on the text via the Slack MCP's draft tool
 *     before invoking this function (which actually sends).
 */
export function sendSlackImage(
  args: SendImageArgs,
  deps: SendImageDeps = {},
): ResultAsync<SendImageResult, SlackImageError> {
  if (!isXoxcToken({ token: args.config.token })) {
    return errAsync(SlackImageErrors.invalidToken());
  }
  const readImage = deps.readImageBytes ?? defaultReadImageBytes;
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const fileName = basename(args.imagePath);
  return ResultAsync.fromPromise(readImage(args.imagePath), (e) =>
    SlackImageErrors.imageReadFailed({
      imagePath: args.imagePath,
      cause: e instanceof Error ? e.message : String(e),
    }),
  )
    .andThen((imageBytes) =>
      getUploadUrl({ config: args.config, fileName, byteLength: imageBytes.byteLength, fetchImpl }).map(
        (uploadInfo) => ({ ...uploadInfo, imageBytes }),
      ),
    )
    .andThen(({ uploadUrl, fileId, imageBytes }) => uploadBytes({ uploadUrl, imageBytes, fetchImpl }).map(() => fileId))
    .andThen((fileId) => completeUpload({ config: args.config, fileId, fileName, fetchImpl }).map(() => fileId))
    .andThen((fileId) =>
      shareFile({
        config: args.config,
        fileId,
        channelId: args.channelId,
        text: args.text,
        ...(args.threadTs !== undefined ? { threadTs: args.threadTs } : {}),
        fetchImpl,
      }),
    );
}

async function defaultReadImageBytes(path: string): Promise<Buffer> {
  return readFile(path);
}
