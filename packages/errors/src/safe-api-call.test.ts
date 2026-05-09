import { describe, expect, it } from 'vitest';
import { safeApiCall } from './safe-api-call.ts';

describe('safeApiCall', () => {
  it('returns ok with the resolved value on success', async () => {
    const result = await safeApiCall({
      execute: () => Promise.resolve({ id: 1, name: 'kit' }),
      provider: 'test',
    });

    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value).toEqual({ id: 1, name: 'kit' });
    }
  });

  it('wraps a thrown Error into an ApiCallError carrying provider, message, and cause', async () => {
    const cause = new Error('upstream said no');
    const result = await safeApiCall({
      execute: () => {
        throw cause;
      },
      provider: 'github',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.provider).toBe('github');
      expect(result.error.message).toBe('upstream said no');
      expect(result.error.cause).toBe(cause);
    }
  });

  it('uses the extractor to pull SDK-specific fields, then enforces provider/message/cause', async () => {
    const cause = { status: 429, body: { error: 'rate_limit' } };
    const result = await safeApiCall({
      execute: () => Promise.reject(cause),
      provider: 'slack',
      extractError: ({ error }) => {
        const e = error as { status?: number; body?: { error?: string } };
        const out: Partial<{ status: number; code: string }> = {};
        if (typeof e.status === 'number') out.status = e.status;
        if (typeof e.body?.error === 'string') out.code = e.body.error;
        return out;
      },
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.status).toBe(429);
      expect(result.error.code).toBe('rate_limit');
      expect(result.error.provider).toBe('slack');
      expect(result.error.cause).toBe(cause);
    }
  });

  it('falls back to a generic message when the thrown value is not an Error or string', async () => {
    const result = await safeApiCall({
      execute: () => Promise.reject({ weird: 'shape' }),
      provider: 'test',
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe('API call failed');
    }
  });

  it('uses the extracted message when the extractor provides one', async () => {
    const result = await safeApiCall({
      execute: () => Promise.reject(new Error('raw')),
      provider: 'test',
      extractError: () => ({ message: 'extracted' }),
    });

    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.message).toBe('extracted');
    }
  });
});
