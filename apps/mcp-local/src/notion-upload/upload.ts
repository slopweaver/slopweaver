/**
 * Drive the four-call Notion image-upload sequence. Each step returns
 * a `ResultAsync` so failure at any boundary surfaces as a typed
 * `NotionUploadError` rather than an exception.
 *
 * Steps:
 *   1. POST /api/v3/loadPageChunk    -> discover the page's space_id
 *   2. POST /api/v3/getUploadFileUrl -> S3 signedPutUrl + attachment URL
 *   3. PUT  <signedPutUrl>           -> stores the image bytes
 *   4. POST /api/v3/saveTransactionsFanout -> creates the image block
 *
 * UUID + `now()` are injected via `deps` so the unit suite can pin
 * the exact request bodies without relying on `Math.random` / Date.
 */

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { errAsync, okAsync, ResultAsync } from '@slopweaver/errors';
import { NotionUploadErrors, type NotionUploadError } from './errors.ts';
import { extractFileUuid, normalisePageRef } from './page-ref.ts';
import { buildSaveTransactionsBody } from './transaction-body.ts';
import type { NotionUploadConfig, UploadImageArgs, UploadImageResult } from './types.ts';

export type UploadImageDeps = {
  readonly fetchImpl?: typeof fetch;
  readonly readImageBytes?: (path: string) => Promise<Buffer>;
  readonly genUuid?: () => string;
  readonly now?: () => number;
};

const DEFAULT_API_BASE = 'https://www.notion.so';

function buildApiUrl({ config, method }: { config: NotionUploadConfig; method: string }): string {
  const base = (config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '');
  return `${base}/api/v3/${method}`;
}

function buildHeaders({ config }: { config: NotionUploadConfig }): Headers {
  const headers = new Headers({
    'content-type': 'application/json',
    cookie: `token_v2=${config.tokenV2}`,
    'notion-audit-log-platform': 'web',
    origin: config.apiBaseUrl ?? DEFAULT_API_BASE,
    referer: `${config.apiBaseUrl ?? DEFAULT_API_BASE}/`,
  });
  if (config.userId !== undefined && config.userId.length > 0) {
    headers.set('x-notion-active-user-header', config.userId);
  }
  return headers;
}

type SpaceIdResult = { spaceId: string };
type GetUploadUrlResult = {
  signedPutUrl: string;
  attachmentUrl: string;
  fileUuid: string;
  putHeaders: ReadonlyArray<{ name: string; value: string }>;
};

function loadSpaceId({
  config,
  pageId,
  fetchImpl,
}: {
  config: NotionUploadConfig;
  pageId: string;
  fetchImpl: typeof fetch;
}): ResultAsync<SpaceIdResult, NotionUploadError> {
  return ResultAsync.fromPromise(
    fetchImpl(buildApiUrl({ config, method: 'loadPageChunk' }), {
      method: 'POST',
      headers: buildHeaders({ config }),
      body: JSON.stringify({
        pageId,
        limit: 1,
        chunkNumber: 0,
        cursor: { stack: [] },
        verticalColumns: false,
      }),
    }),
    (e) => NotionUploadErrors.loadChunkFailed({ cause: e instanceof Error ? e.message : String(e) }),
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<SpaceIdResult, NotionUploadError>(
        NotionUploadErrors.loadChunkFailed({ cause: `http ${res.status}`, httpStatus: res.status }),
      );
    }
    return ResultAsync.fromPromise(res.json(), () =>
      NotionUploadErrors.loadChunkFailed({ cause: 'unparseable JSON' }),
    ).andThen((json) => {
      const spaceId = readSpaceIdFromPageChunk({ json, pageId });
      if (spaceId === null) {
        return errAsync<SpaceIdResult, NotionUploadError>(
          NotionUploadErrors.loadChunkFailed({ cause: 'space_id not found in loadPageChunk response' }),
        );
      }
      return okAsync<SpaceIdResult, NotionUploadError>({ spaceId });
    });
  });
}

function readSpaceIdFromPageChunk({ json, pageId }: { json: unknown; pageId: string }): string | null {
  if (json === null || typeof json !== 'object') return null;
  const recordMap = (json as { recordMap?: unknown }).recordMap;
  if (recordMap === null || typeof recordMap !== 'object') return null;
  const blockMap = (recordMap as { block?: unknown }).block;
  if (blockMap === null || typeof blockMap !== 'object') return null;
  const record = (blockMap as Record<string, unknown>)[pageId];
  if (record === null || typeof record !== 'object') return null;
  const recordValue = (record as { value?: unknown }).value;
  // Notion sometimes nests the page block one level deeper. Accept either.
  const blockValue =
    recordValue !== null && typeof recordValue === 'object' && 'value' in recordValue ? recordValue.value : recordValue;
  if (blockValue === null || typeof blockValue !== 'object') return null;
  const spaceId = (blockValue as { space_id?: unknown }).space_id;
  return typeof spaceId === 'string' && spaceId.length > 0 ? spaceId : null;
}

function getUploadUrl({
  config,
  pageId,
  spaceId,
  fileName,
  contentType,
  fetchImpl,
}: {
  config: NotionUploadConfig;
  pageId: string;
  spaceId: string;
  fileName: string;
  contentType: string;
  fetchImpl: typeof fetch;
}): ResultAsync<GetUploadUrlResult, NotionUploadError> {
  return ResultAsync.fromPromise(
    fetchImpl(buildApiUrl({ config, method: 'getUploadFileUrl' }), {
      method: 'POST',
      headers: buildHeaders({ config }),
      body: JSON.stringify({
        bucket: 'secure',
        name: fileName,
        contentType,
        record: { table: 'block', id: pageId, spaceId },
      }),
    }),
    (e) => NotionUploadErrors.uploadUrlFailed({ cause: e instanceof Error ? e.message : String(e) }),
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<GetUploadUrlResult, NotionUploadError>(
        NotionUploadErrors.uploadUrlFailed({ cause: `http ${res.status}`, httpStatus: res.status }),
      );
    }
    return ResultAsync.fromPromise(res.json(), () =>
      NotionUploadErrors.uploadUrlFailed({ cause: 'unparseable JSON' }),
    ).andThen((json) => {
      if (json === null || typeof json !== 'object') {
        return errAsync<GetUploadUrlResult, NotionUploadError>(
          NotionUploadErrors.uploadUrlFailed({ cause: 'response was not an object' }),
        );
      }
      const obj = json as Record<string, unknown>;
      const signedPutUrl = typeof obj['signedPutUrl'] === 'string' ? obj['signedPutUrl'] : null;
      const attachmentUrl = typeof obj['url'] === 'string' ? obj['url'] : null;
      if (signedPutUrl === null || attachmentUrl === null) {
        return errAsync<GetUploadUrlResult, NotionUploadError>(
          NotionUploadErrors.uploadUrlFailed({ cause: 'response missing signedPutUrl or url' }),
        );
      }
      const fileUuid = extractFileUuid({ attachmentUrl });
      if (fileUuid === null) {
        return errAsync<GetUploadUrlResult, NotionUploadError>(
          NotionUploadErrors.uploadUrlFailed({ cause: `could not extract file UUID from ${attachmentUrl}` }),
        );
      }
      const putHeadersRaw = Array.isArray(obj['putHeaders']) ? (obj['putHeaders'] as unknown[]) : [];
      const putHeaders: Array<{ name: string; value: string }> = [];
      for (const entry of putHeadersRaw) {
        if (entry !== null && typeof entry === 'object') {
          const name = (entry as { name?: unknown }).name;
          const value = (entry as { value?: unknown }).value;
          if (typeof name === 'string' && typeof value === 'string') {
            putHeaders.push({ name, value });
          }
        }
      }
      return okAsync<GetUploadUrlResult, NotionUploadError>({ signedPutUrl, attachmentUrl, fileUuid, putHeaders });
    });
  });
}

function uploadBytes({
  signedPutUrl,
  putHeaders,
  imageBytes,
  contentType,
  fetchImpl,
}: {
  signedPutUrl: string;
  putHeaders: ReadonlyArray<{ name: string; value: string }>;
  imageBytes: Buffer;
  contentType: string;
  fetchImpl: typeof fetch;
}): ResultAsync<void, NotionUploadError> {
  const headers = new Headers();
  for (const { name, value } of putHeaders) headers.set(name, value);
  if (!headers.has('content-type')) headers.set('content-type', contentType);
  return ResultAsync.fromPromise(
    fetchImpl(signedPutUrl, {
      method: 'PUT',
      headers,
      body: new Uint8Array(imageBytes.buffer, imageBytes.byteOffset, imageBytes.byteLength),
    }),
    (e) => NotionUploadErrors.bytesUploadFailed({ cause: e instanceof Error ? e.message : String(e) }),
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<void, NotionUploadError>(
        NotionUploadErrors.bytesUploadFailed({ cause: `http ${res.status}`, httpStatus: res.status }),
      );
    }
    return okAsync<void, NotionUploadError>(undefined);
  });
}

function saveTransactions({
  config,
  pageId,
  spaceId,
  attachmentUrl,
  fileUuid,
  newBlockId,
  requestId,
  transactionId,
  nowMs,
  fetchImpl,
}: {
  config: NotionUploadConfig;
  pageId: string;
  spaceId: string;
  attachmentUrl: string;
  fileUuid: string;
  newBlockId: string;
  requestId: string;
  transactionId: string;
  nowMs: number;
  fetchImpl: typeof fetch;
}): ResultAsync<void, NotionUploadError> {
  const body = buildSaveTransactionsBody({
    pageId,
    spaceId,
    attachmentUrl,
    fileUuid,
    newBlockId,
    requestId,
    transactionId,
    nowMs,
  });
  return ResultAsync.fromPromise(
    fetchImpl(buildApiUrl({ config, method: 'saveTransactionsFanout' }), {
      method: 'POST',
      headers: buildHeaders({ config }),
      body: JSON.stringify(body),
    }),
    (e) => NotionUploadErrors.saveTransactionsFailed({ cause: e instanceof Error ? e.message : String(e) }),
  ).andThen((res) => {
    if (!res.ok) {
      return errAsync<void, NotionUploadError>(
        NotionUploadErrors.saveTransactionsFailed({ cause: `http ${res.status}`, httpStatus: res.status }),
      );
    }
    return okAsync<void, NotionUploadError>(undefined);
  });
}

function detectContentType(fileName: string): string {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Upload an image to a Notion page, creating a new image block and
 * appending it to the page content. Returns the new block UUID,
 * attachment URL, file UUID, and page URL.
 */
export function uploadNotionImage(
  args: UploadImageArgs,
  deps: UploadImageDeps = {},
): ResultAsync<UploadImageResult, NotionUploadError> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const readImage = deps.readImageBytes ?? defaultReadImageBytes;
  const genUuid = deps.genUuid ?? randomUUID;
  const now = deps.now ?? Date.now;
  const fileName = basename(args.imagePath);
  const contentType = detectContentType(fileName);

  const pageIdResult = normalisePageRef({ pageRef: args.pageRef });
  if (pageIdResult.isErr()) {
    return errAsync(pageIdResult.error);
  }
  const pageId = pageIdResult.value;

  return ResultAsync.fromPromise(readImage(args.imagePath), (e) =>
    NotionUploadErrors.imageReadFailed({
      imagePath: args.imagePath,
      cause: e instanceof Error ? e.message : String(e),
    }),
  )
    .andThen((imageBytes) =>
      loadSpaceId({ config: args.config, pageId, fetchImpl }).map(({ spaceId }) => ({ imageBytes, spaceId })),
    )
    .andThen(({ imageBytes, spaceId }) =>
      getUploadUrl({ config: args.config, pageId, spaceId, fileName, contentType, fetchImpl }).map((upload) => ({
        imageBytes,
        spaceId,
        ...upload,
      })),
    )
    .andThen(({ imageBytes, spaceId, signedPutUrl, attachmentUrl, fileUuid, putHeaders }) =>
      uploadBytes({ signedPutUrl, putHeaders, imageBytes, contentType, fetchImpl }).map(() => ({
        spaceId,
        attachmentUrl,
        fileUuid,
      })),
    )
    .andThen(({ spaceId, attachmentUrl, fileUuid }) => {
      const newBlockId = genUuid();
      const requestId = genUuid();
      const transactionId = genUuid();
      const nowMs = now();
      return saveTransactions({
        config: args.config,
        pageId,
        spaceId,
        attachmentUrl,
        fileUuid,
        newBlockId,
        requestId,
        transactionId,
        nowMs,
        fetchImpl,
      }).map(() => ({
        blockId: newBlockId,
        attachmentUrl,
        fileUuid,
        pageUrl: `${(args.config.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/+$/, '')}/${pageId.replaceAll('-', '')}`,
      }));
    });
}

async function defaultReadImageBytes(path: string): Promise<Buffer> {
  return readFile(path);
}
