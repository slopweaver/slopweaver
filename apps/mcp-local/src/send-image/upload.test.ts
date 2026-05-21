import { describe, expect, it, vi } from 'vitest';
import { sendSlackImage } from './upload.ts';
import type { SlackImageUploadConfig } from './types.ts';

const FAKE_IMAGE = Buffer.from('PNG-bytes-go-here');

const STANDARD_CONFIG: SlackImageUploadConfig = {
  apiBaseUrl: 'https://acme.slack.com',
  token: 'xoxc-FAKE-USER-TOKEN-FOR-TESTS',
};

const ENTERPRISE_CONFIG: SlackImageUploadConfig = {
  apiBaseUrl: 'https://acme.enterprise.slack.com',
  slackRoute: 'E0000000000:T1111111111',
  token: 'xoxc-FAKE-USER-TOKEN-FOR-TESTS',
};

type CallRecord = { url: string; init: RequestInit | undefined };

/**
 * Build a `fetch` stub from a list of pre-canned responses. Each call
 * is matched in order; the `i`th call returns the `i`th response. Any
 * mismatch surfaces as a test-failing rejection so silent drift in
 * call order shows up loudly.
 */
function makeFetchStub({
  responses,
}: {
  responses: ReadonlyArray<{ status: number; json?: unknown; text?: string }>;
}): {
  fetchImpl: typeof fetch;
  calls: CallRecord[];
} {
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

describe('sendSlackImage', () => {
  it('rejects a non-xoxc token before any fetch', async () => {
    const { fetchImpl, calls } = makeFetchStub({ responses: [] });
    const result = await sendSlackImage(
      {
        config: { ...STANDARD_CONFIG, token: 'xoxb-bot-token' },
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: vi.fn() },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('SLACK_IMAGE_INVALID_TOKEN');
    }
    expect(calls).toHaveLength(0);
  });

  it('returns SLACK_IMAGE_READ_FAILED when reading the image throws', async () => {
    const { fetchImpl, calls } = makeFetchStub({ responses: [] });
    const result = await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/missing.png',
      },
      {
        fetchImpl,
        readImageBytes: async () => {
          throw new Error('ENOENT: no such file');
        },
      },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('SLACK_IMAGE_READ_FAILED');
      if (result.error.code === 'SLACK_IMAGE_READ_FAILED') {
        expect(result.error.imagePath).toBe('/tmp/missing.png');
      }
    }
    expect(calls).toHaveLength(0);
  });

  it('returns SLACK_IMAGE_UPLOAD_URL_FAILED on a non-2xx response from files.getUploadURL', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [{ status: 500, text: 'server fell over' }],
    });
    const result = await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.code).toBe('SLACK_IMAGE_UPLOAD_URL_FAILED');
    }
  });

  it('returns SLACK_IMAGE_UPLOAD_URL_FAILED with slackError when files.getUploadURL returns ok:false', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [{ status: 200, json: { ok: false, error: 'invalid_auth' } }],
    });
    const result = await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'SLACK_IMAGE_UPLOAD_URL_FAILED') {
      expect(result.error.slackError).toBe('invalid_auth');
    }
  });

  it('returns SLACK_IMAGE_BYTES_UPLOAD_FAILED on a non-2xx binary PUT', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 502, text: 'bad gateway' },
      ],
    });
    const result = await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'SLACK_IMAGE_BYTES_UPLOAD_FAILED') {
      expect(result.error.httpStatus).toBe(502);
    }
  });

  it('returns SLACK_IMAGE_COMPLETE_FAILED when files.completeUpload returns ok:false', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 200, text: '' },
        { status: 200, json: { ok: false, error: 'file_not_found' } },
      ],
    });
    const result = await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'SLACK_IMAGE_COMPLETE_FAILED') {
      expect(result.error.slackError).toBe('file_not_found');
    }
  });

  it('returns SLACK_IMAGE_SHARE_FAILED when files.share returns ok:false', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 200, text: '' },
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: false, error: 'channel_not_found' } },
      ],
    });
    const result = await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C-bad',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    expect(result.isErr()).toBe(true);
    if (result.isErr() && result.error.code === 'SLACK_IMAGE_SHARE_FAILED') {
      expect(result.error.slackError).toBe('channel_not_found');
    }
  });

  it('happy path: returns fileId + fileMsgTs and issues four sequential POSTs', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 200, text: '' },
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: true, ts: '1779999999.123456' } },
      ],
    });
    const result = await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hello world',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.fileId).toBe('F0001');
      expect(result.value.fileMsgTs).toBe('1779999999.123456');
    }
    expect(calls).toHaveLength(4);
    expect(calls[0]?.url).toBe('https://acme.slack.com/api/files.getUploadURL');
    expect(calls[1]?.url).toBe('https://files.slack.com/upload/v1/abc');
    expect(calls[2]?.url).toBe('https://acme.slack.com/api/files.completeUpload');
    expect(calls[3]?.url).toBe('https://acme.slack.com/api/files.share');
  });

  it('happy path: passes file_msg_ts when ts is absent (workspace tier variance)', async () => {
    const { fetchImpl } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 200, text: '' },
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: true, file_msg_ts: '1779999999.999999' } },
      ],
    });
    const result = await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.fileMsgTs).toBe('1779999999.999999');
    }
  });

  it('enterprise grid: appends slack_route query param to each api call', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 200, text: '' },
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: true, ts: '1.1' } },
      ],
    });
    await sendSlackImage(
      {
        config: ENTERPRISE_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    expect(calls[0]?.url).toBe(
      'https://acme.enterprise.slack.com/api/files.getUploadURL?slack_route=E0000000000%3AT1111111111',
    );
    expect(calls[2]?.url).toBe(
      'https://acme.enterprise.slack.com/api/files.completeUpload?slack_route=E0000000000%3AT1111111111',
    );
    expect(calls[3]?.url).toBe(
      'https://acme.enterprise.slack.com/api/files.share?slack_route=E0000000000%3AT1111111111',
    );
    // The bytes PUT goes to the upload_url verbatim. Slack returns a
    // fully-qualified URL there; we don't add slack_route to that call.
    expect(calls[1]?.url).toBe('https://files.slack.com/upload/v1/abc');
  });

  it('thread reply: sends thread_ts in the files.share form body', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 200, text: '' },
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: true, ts: '1.1' } },
      ],
    });
    await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        threadTs: '1779326689.858299',
        text: 'reply',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    const shareCall = calls[3];
    expect(shareCall).toBeDefined();
    if (shareCall === undefined) return;
    const body = shareCall.init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (body instanceof URLSearchParams) {
      expect(body.get('thread_ts')).toBe('1779326689.858299');
      expect(body.get('channel')).toBe('C0123456789');
      expect(body.get('text')).toBe('reply');
      expect(body.get('file')).toBe('F0001');
    }
  });

  it('does not leak the xoxc token into URL query strings on any call', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 200, text: '' },
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: true, ts: '1.1' } },
      ],
    });
    await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/tmp/example.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    for (const call of calls) {
      expect(call.url).not.toContain('xoxc-');
    }
  });

  it('sends the byte length in files.getUploadURL form body', async () => {
    const { fetchImpl, calls } = makeFetchStub({
      responses: [
        { status: 200, json: { ok: true, upload_url: 'https://files.slack.com/upload/v1/abc', file_id: 'F0001' } },
        { status: 200, text: '' },
        { status: 200, json: { ok: true } },
        { status: 200, json: { ok: true, ts: '1.1' } },
      ],
    });
    await sendSlackImage(
      {
        config: STANDARD_CONFIG,
        channelId: 'C0123456789',
        text: 'hi',
        imagePath: '/path/with spaces/photo.png',
      },
      { fetchImpl, readImageBytes: async () => FAKE_IMAGE },
    );
    const body = calls[0]?.init?.body;
    expect(body).toBeInstanceOf(URLSearchParams);
    if (body instanceof URLSearchParams) {
      expect(body.get('filename')).toBe('photo.png');
      expect(body.get('length')).toBe(String(FAKE_IMAGE.byteLength));
    }
  });
});
