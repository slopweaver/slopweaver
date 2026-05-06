/**
 * Polly setup for @slopweaver/integrations-github tests.
 *
 * Wired via vitest.config.ts `setupFiles`. Each test gets its own cassette under
 * `<test-file-dir>/__recordings__/<suite>/<test>/recording.har`.
 *
 * Modes (POLLY_MODE env):
 *   - replay (default): read from cassette; missing cassette → test fails
 *   - record: hit live api.github.com, write cassette (requires GITHUB_PAT)
 *
 * Native `fetch` (undici) bypasses Polly's node-http adapter, so we replace
 * `globalThis.fetch` with `node-fetch` at load time. node-fetch routes through
 * the http module where Polly intercepts. Restored in afterAll.
 *
 * `nock.disableNetConnect()` is a defense-in-depth net guard — any HTTP call
 * that slips past Polly fails immediately instead of silently hitting live APIs.
 *
 * Header/body redaction runs at `beforePersist`, so cassettes never contain
 * raw `Authorization: Bearer ghp_…` even if a recording is taken locally.
 *
 * Adapted from the SaaS repo's test setup (apps/api/src/__tests__/setup-polly.ts),
 * with SSE / Linear / Anthropic-specific code removed.
 */

import path from 'node:path';
import NodeHttpAdapter from '@pollyjs/adapter-node-http';
import { Polly, type PollyConfig } from '@pollyjs/core';
import FSPersister from '@pollyjs/persister-fs';
import nock from 'nock';
import { afterAll, afterEach, beforeEach } from 'vitest';

type RedactableHeader = { name: string; value?: string };
type RedactableCookie = { name: string; value?: string };

const nativeFetch = globalThis.fetch;
const POLLY_MODE = (process.env['POLLY_MODE'] ?? 'replay') as PollyConfig['mode'];

if (POLLY_MODE !== 'passthrough') {
  // node-fetch v3 is ESM-only; top-level await is supported in vitest setup files.
  // Native fetch (undici) bypasses Polly's node-http adapter, so we route through
  // node-fetch which uses node:http internally.
  const { default: nodeFetchFn } = (await import('node-fetch')) as unknown as {
    default: typeof fetch;
  };
  globalThis.fetch = (async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    const headers = new Headers(init?.headers);
    headers.set('accept-encoding', 'identity');
    return (await nodeFetchFn(input, { ...init, headers })) as Response;
  }) as typeof fetch;
}

if (POLLY_MODE === 'record' || POLLY_MODE === 'passthrough') {
  nock.enableNetConnect();
} else {
  nock.disableNetConnect();
  nock.enableNetConnect(
    (host) => host.includes('localhost') || host.includes('127.0.0.1') || host.includes('[::1]'),
  );
}

// Polly's `register` typing is overly strict against default-exported CJS classes;
// the runtime call is fine (matches the SaaS repo's setup verbatim).
Polly.register(NodeHttpAdapter as never);
Polly.register(FSPersister as never);

let polly: Polly | null = null;
let missingReplayRecordings: string[] = [];

const REDACT_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-github-request-id',
]);
const REDACT_KEY_REGEX = /token|secret|authorization|password|api[-_]?key/i;
const REDACT_VALUE_REGEX = /(gh[pousr]_[A-Za-z0-9]{16,})/g;

function redactHeaders({
  headers,
}: {
  headers?: RedactableHeader[] | undefined;
}): RedactableHeader[] {
  if (!headers) {
    return [];
  }
  return headers.filter((h) => !REDACT_HEADER_NAMES.has(h.name.toLowerCase()));
}

function redactCookies({
  cookies,
}: {
  cookies?: RedactableCookie[] | undefined;
}): RedactableCookie[] {
  if (!cookies) {
    return [];
  }
  return cookies.map((c) => ({ ...c, value: '[REDACTED]' }));
}

function redactJson({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactJson({ value: entry }));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      output[k] = REDACT_KEY_REGEX.test(k) ? '[REDACTED]' : redactJson({ value: v });
    }
    return output;
  }
  if (typeof value === 'string') {
    return value.replace(REDACT_VALUE_REGEX, '[REDACTED-PAT]');
  }
  return value;
}

function redactText({ text }: { text: string }): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return text;
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactJson({ value: JSON.parse(trimmed) }));
    } catch {
      // fall through
    }
  }
  return text.replace(REDACT_VALUE_REGEX, '[REDACTED-PAT]');
}

function isMissingReplayRecording({ error }: { error: unknown }): boolean {
  return (
    error instanceof Error &&
    error.message.includes('Recording for the following request is not found') &&
    error.message.includes('recordIfMissing') &&
    error.message.includes('false')
  );
}

beforeEach(async ({ task }) => {
  missingReplayRecordings = [];

  if (polly) {
    try {
      await polly.stop();
    } catch {
      // ignore double-stop
    }
    polly = null;
  }

  if (POLLY_MODE === 'passthrough') {
    return;
  }

  const suiteName = task.suite?.name ?? 'unknown-suite';
  const testName = task.name ?? 'unknown-test';
  const cassetteName = `${suiteName}/${testName}`;
  const testFilePath = task.file?.filepath ?? '';
  const recordingsDir = path.join(path.dirname(testFilePath), '__recordings__');

  polly = new Polly(cassetteName, {
    adapters: ['node-http'],
    flushRequestsOnStop: true,
    logLevel: 'error',
    matchRequestsBy: {
      body: false,
      headers: false,
      method: true,
      order: false,
      url: { hostname: true, pathname: true, protocol: true, query: false },
    },
    mode: POLLY_MODE,
    persister: 'fs',
    persisterOptions: { fs: { recordingsDir } },
    recordFailedRequests: true,
    recordIfMissing: POLLY_MODE === 'record',
  });

  // biome-ignore lint/suspicious/noExplicitAny: Polly types for recording payload are loose
  polly.server.any().on('beforePersist', (_req, recording: any) => {
    if (recording?.request) {
      if (Array.isArray(recording.request.headers)) {
        recording.request.headers = redactHeaders({ headers: recording.request.headers });
      }
      if (Array.isArray(recording.request.cookies)) {
        recording.request.cookies = redactCookies({ cookies: recording.request.cookies });
      }
      if (typeof recording.request.postData?.text === 'string') {
        recording.request.postData.text = redactText({ text: recording.request.postData.text });
      }
    }
    if (recording?.response) {
      if (Array.isArray(recording.response.headers)) {
        recording.response.headers = redactHeaders({ headers: recording.response.headers });
      }
      if (Array.isArray(recording.response.cookies)) {
        recording.response.cookies = redactCookies({ cookies: recording.response.cookies });
      }
      if (typeof recording.response.content?.text === 'string') {
        recording.response.content.text = redactText({ text: recording.response.content.text });
      }
    }
  });

  polly.server.any().on('error', (req, error) => {
    if (POLLY_MODE === 'replay' && isMissingReplayRecording({ error })) {
      missingReplayRecordings.push(`${req?.method ?? 'UNKNOWN'} ${req?.url ?? 'unknown-url'}`);
      process.exitCode = 1;
    }
  });
});

afterEach(async () => {
  if (polly) {
    await polly.flush();
    await polly.stop();
    polly = null;
  }
  if (missingReplayRecordings.length > 0) {
    throw new Error(
      `Missing Polly recording(s) in replay mode:\n${missingReplayRecordings.join('\n')}\n` +
        'Run with POLLY_MODE=record to regenerate cassettes for this test.',
    );
  }
});

afterAll(() => {
  globalThis.fetch = nativeFetch;
  nock.cleanAll();
  nock.enableNetConnect();
});
