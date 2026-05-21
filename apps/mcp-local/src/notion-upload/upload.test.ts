import { describe, expect, it } from 'vitest';
import { uploadNotionImage } from './upload.ts';
import type { NotionUploadConfig } from './types.ts';

const FAKE_IMAGE = Buffer.from('PNG-bytes-go-here');

const CONFIG: NotionUploadConfig = {
  tokenV2: 'TEST-NOTION-COOKIE',
  apiBaseUrl: 'https://www.notion.example',
};

const PAGE_ID = '367cd3c7-9a56-8160-bb65-cf3e4e419208';
const SPACE_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const FILE_UUID = '11111111-2222-3333-4444-555555555555';
const ATTACHMENT_URL = `attachment:${FILE_UUID}:photo.png`;
const SIGNED_PUT_URL = 'https://files.notion.example/upload/signed-put-url';
const NEW_BLOCK_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const REQUEST_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const TXN_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

type CallRecord = { url: string; init: RequestInit | undefined };

function makeFetchStub({
  responses,
}: {
  responses: ReadonlyArray<{ status: number; json?: unknown; text?: string }>;
}): { fetchImpl: typeof fetch; calls: CallRecord[] } {
  const calls: CallRecord[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, init });
    const idx = calls.length - 1;
    const spec = responses[idx];
    if (spec === undefined) {
      throw new Error(`fetch stub: no response queued for call ${idx + 1} (${url})`);
    }
    return new Response(spec.json !== undefined ? JSON.stringify(spec.json) : (spec.text ?? ''), {
      status: spec.status,
      headers: { 'content-type': spec.json !== undefined ? 'application/json' : 'text/plain' },
    });
  };
  return { fetchImpl, calls };
}

function chunkPageResponse({ pageId, spaceId }: { pageId: string; spaceId: string }): unknown {
  return {
    recordMap: {
      block: {
        [pageId]: { value: { id: pageId, space_id: spaceId } },
      },
    },
  };
}

let uuidCounter = 0;
function makeUuidGen(): () => string {
  uuidCounter = 0;
  const sequence = [NEW_BLOCK_ID, REQUEST_ID, TXN_ID];
  return () => {
    const v = sequence[uuidCounter];
    uuidCounter++;
    return v ?? '00000000-0000-0000-0000-000000000000';
  };
}

describe('uploadNotionImage', () => {
  it('rejects an unparseable pageRef before any fetch', async () => {
    const { fetchImpl, calls } = makeFetchStub({ responses: [] });
    const result = await uploadNotionImage(
      { config: CONFIG, pageRef: 'not-a-uuid', imagePath: '/tmp/x.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('NOTION_INVALID_PAGE_REF');
    expect(calls).toHaveLength(0);
  });

  it('happy path: returns the new block id + attachment URL after 4 sequential calls', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: chunkPageResponse({ pageId: PAGE_ID, spaceId: SPACE_ID }) },
        { status: 200, json: { signedPutUrl: SIGNED_PUT_URL, url: ATTACHMENT_URL, putHeaders: [] } },
        { status: 200, text: '' },
        { status: 200, json: {} },
      ],
    });
    const result = await uploadNotionImage(
      { config: CONFIG, pageRef: PAGE_ID, imagePath: '/tmp/photo.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1_700_000_000_000 },
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.blockId).toBe(NEW_BLOCK_ID);
      expect(result.value.attachmentUrl).toBe(ATTACHMENT_URL);
      expect(result.value.fileUuid).toBe(FILE_UUID);
      expect(result.value.pageUrl).toBe(`https://www.notion.example/${PAGE_ID.replaceAll('-', '')}`);
    }
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe('https://www.notion.example/api/v3/loadPageChunk');
    expect(calls[1]?.url).toBe('https://www.notion.example/api/v3/getUploadFileUrl');
    expect(calls[2]?.url).toBe(SIGNED_PUT_URL);
    expect(calls[3]?.url).toBe('https://www.notion.example/api/v3/saveTransactionsFanout');
  });

  it('sends token_v2 and (when set) x-notion-active-user-header on the notion.so calls', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: chunkPageResponse({ pageId: PAGE_ID, spaceId: SPACE_ID }) },
        { status: 200, json: { signedPutUrl: SIGNED_PUT_URL, url: ATTACHMENT_URL, putHeaders: [] } },
        { status: 200, text: '' },
        { status: 200, json: {} },
      ],
    });
    await uploadNotionImage(
      { config: { ...CONFIG, userId: 'user-abc-123' }, pageRef: PAGE_ID, imagePath: '/tmp/photo.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1 },
    );
    const firstHeaders = calls[0]?.init?.headers;
    expect(firstHeaders).toBeInstanceOf(Headers);
    if (firstHeaders instanceof Headers) {
      expect(firstHeaders.get('cookie')).toBe('token_v2=TEST-NOTION-COOKIE');
      expect(firstHeaders.get('x-notion-active-user-header')).toBe('user-abc-123');
    }
  });

  it('passes putHeaders from the upload response through to the signed PUT', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: chunkPageResponse({ pageId: PAGE_ID, spaceId: SPACE_ID }) },
        {
          status: 200,
          json: {
            signedPutUrl: SIGNED_PUT_URL,
            url: ATTACHMENT_URL,
            putHeaders: [{ name: 'x-amz-acl', value: 'private' }],
          },
        },
        { status: 200, text: '' },
        { status: 200, json: {} },
      ],
    });
    await uploadNotionImage(
      { config: CONFIG, pageRef: PAGE_ID, imagePath: '/tmp/photo.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1 },
    );
    const putHeaders = calls[2]?.init?.headers;
    expect(putHeaders).toBeInstanceOf(Headers);
    if (putHeaders instanceof Headers) {
      expect(putHeaders.get('x-amz-acl')).toBe('private');
      expect(putHeaders.get('content-type')).toBe('image/png');
    }
  });

  it('returns NOTION_LOAD_CHUNK_FAILED when space_id is missing from the chunk response', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [{ status: 200, json: { recordMap: { block: {} } } }],
    });
    const result = await uploadNotionImage(
      { config: CONFIG, pageRef: PAGE_ID, imagePath: '/tmp/photo.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('NOTION_LOAD_CHUNK_FAILED');
  });

  it('returns NOTION_UPLOAD_URL_FAILED when getUploadFileUrl is 401', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [
        { status: 200, json: chunkPageResponse({ pageId: PAGE_ID, spaceId: SPACE_ID }) },
        { status: 401, text: 'invalid_auth' },
      ],
    });
    const result = await uploadNotionImage(
      { config: CONFIG, pageRef: PAGE_ID, imagePath: '/tmp/photo.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'NOTION_UPLOAD_URL_FAILED') {
      expect(result.error.httpStatus).toBe(401);
    }
  });

  it('returns NOTION_BYTES_UPLOAD_FAILED when the S3 PUT fails', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [
        { status: 200, json: chunkPageResponse({ pageId: PAGE_ID, spaceId: SPACE_ID }) },
        { status: 200, json: { signedPutUrl: SIGNED_PUT_URL, url: ATTACHMENT_URL, putHeaders: [] } },
        { status: 502, text: 'bad gateway' },
      ],
    });
    const result = await uploadNotionImage(
      { config: CONFIG, pageRef: PAGE_ID, imagePath: '/tmp/photo.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'NOTION_BYTES_UPLOAD_FAILED') {
      expect(result.error.httpStatus).toBe(502);
    }
  });

  it('returns NOTION_SAVE_TRANSACTIONS_FAILED on a non-2xx final response', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [
        { status: 200, json: chunkPageResponse({ pageId: PAGE_ID, spaceId: SPACE_ID }) },
        { status: 200, json: { signedPutUrl: SIGNED_PUT_URL, url: ATTACHMENT_URL, putHeaders: [] } },
        { status: 200, text: '' },
        { status: 500, text: 'internal' },
      ],
    });
    const result = await uploadNotionImage(
      { config: CONFIG, pageRef: PAGE_ID, imagePath: '/tmp/photo.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1 },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'NOTION_SAVE_TRANSACTIONS_FAILED') {
      expect(result.error.httpStatus).toBe(500);
    }
  });

  it('returns NOTION_IMAGE_READ_FAILED when reading the image throws', async () => {
    const { fetchImpl, calls } = makeFetchStub({ responses: [] });
    const result = await uploadNotionImage(
      { config: CONFIG, pageRef: PAGE_ID, imagePath: '/tmp/missing.png' },
      {
        fetchImpl,
        readImageBytes: async () => {
          throw new Error('ENOENT');
        },
        genUuid: makeUuidGen(),
        now: () => 1,
      },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.code).toBe('NOTION_IMAGE_READ_FAILED');
    expect(calls).toHaveLength(0);
  });

  it('sends the saveTransactionsFanout payload with file_ids set (broken-image fix)', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: chunkPageResponse({ pageId: PAGE_ID, spaceId: SPACE_ID }) },
        { status: 200, json: { signedPutUrl: SIGNED_PUT_URL, url: ATTACHMENT_URL, putHeaders: [] } },
        { status: 200, text: '' },
        { status: 200, json: {} },
      ],
    });
    await uploadNotionImage(
      { config: CONFIG, pageRef: PAGE_ID, imagePath: '/tmp/photo.png' },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE, genUuid: makeUuidGen(), now: () => 1_700_000_000_000 },
    );
    const lastBody = calls[3]?.init?.body;
    expect(typeof lastBody).toBe('string');
    if (typeof lastBody === 'string') {
      const parsed = JSON.parse(lastBody) as { transactions: Array<{ operations: Array<Record<string, unknown>> }> };
      const updateOp = parsed.transactions[0]?.operations[0];
      const updateArgs = (updateOp as { args: { file_ids: string[]; parent_id: string } }).args;
      expect(updateArgs.file_ids).toEqual([FILE_UUID]);
      expect(updateArgs.parent_id).toBe(PAGE_ID);
    }
  });
});
