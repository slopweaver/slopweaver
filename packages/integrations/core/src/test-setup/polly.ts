/**
 * Polly cassette plumbing shared across SlopWeaver integration packages.
 *
 * Each package's vitest setup file is a 5-line call into `definePollySetup`.
 * Package-specific concerns (PII placeholders, request rewriting, additional
 * redactors) plug in via the `extraRedactors` and `extraRequestRewriter`
 * options.
 *
 * Wired via `vitest.config.ts` `setupFiles`. Each test gets its own cassette
 * under `<test-file-dir>/__recordings__/<suite>/<test>/recording.har`.
 *
 * Modes (POLLY_MODE env):
 *   - replay (default): read from cassette; missing cassette → test fails
 *   - record: hit live API, write cassette (requires platform token)
 *   - passthrough: skip Polly entirely (debug only)
 *
 * Native `fetch` (undici) bypasses Polly's node-http adapter, so we replace
 * `globalThis.fetch` with `node-fetch` at load time. node-fetch routes through
 * the http module where Polly intercepts. Restored in `afterAll`.
 *
 * `nock.disableNetConnect()` is a defense-in-depth net guard — any HTTP call
 * that slips past Polly fails immediately instead of silently hitting live APIs.
 *
 * Header/body redaction runs at `beforePersist`, so cassettes never contain
 * raw `Authorization: Bearer …` tokens even when recorded locally.
 *
 * Adapted from the SaaS repo's test setup, with SSE / Linear / Anthropic
 * specifics removed.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
import NodeHttpAdapter from '@pollyjs/adapter-node-http';
import { Polly, type PollyConfig } from '@pollyjs/core';
import FSPersister from '@pollyjs/persister-fs';
import nock from 'nock';
import { afterAll, afterEach, beforeEach } from 'vitest';

export type RedactableHeader = { name: string; value?: string };
export type RedactableCookie = { name: string; value?: string };

type RecordingContent = { encoding?: string; size?: number; text?: string };

/**
 * Recording shape the redactor hooks receive. Loose by design — Polly's own
 * types are too strict against the runtime payload, and integration packages
 * only need to mutate `request` / `response` in well-defined places.
 */
export type PollyRecording = {
  request?: {
    url?: string;
    headers?: RedactableHeader[];
    cookies?: RedactableCookie[];
    postData?: { text?: string };
  };
  response?: {
    headers?: RedactableHeader[];
    cookies?: RedactableCookie[];
    content?: RecordingContent;
  };
};

export type ExtraRedactor = (recording: PollyRecording) => void;

export type DefinePollySetupArgs = {
  /**
   * Per-package redactors run after the default header/cookie/token-string
   * redaction. Use these to scrub platform-specific PII (display names,
   * channel names, message bodies, etc.) before cassette persistence.
   */
  extraRedactors?: ExtraRedactor[];
  /**
   * Per-package request URL rewriter applied only in record mode. The github
   * package uses this to scope `/search/issues` queries to a public repo so
   * even an over-scoped PAT can only return public data.
   */
  extraRequestRewriter?: (urlString: string) => string;
};

const DEFAULT_REDACT_HEADER_NAMES = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-github-request-id',
  'github-authentication-token-expiration',
]);
const REDACT_KEY_REGEX = /token|secret|authorization|password|api[-_]?key/i;
// Matches GitHub PATs (gh{p,o,u,s,r}_…), Slack tokens (xox{a,b,p,o,r,e,d,s}-…).
const REDACT_VALUE_REGEX = /(gh[pousr]_[A-Za-z0-9]{16,}|xox[aboprdes]-[A-Za-z0-9-]{8,})/g;

function loadDotEnvFromMonorepoRoot(): void {
  try {
    // /packages/integrations/core/src/test-setup/polly.ts → ../../../../../.env
    const envPath = fileURLToPath(new URL('../../../../../.env', import.meta.url));
    const envContent = readFileSync(envPath, 'utf8');
    for (const rawLine of envContent.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eqIdx = line.indexOf('=');
      if (eqIdx < 0) continue;
      const key = line.slice(0, eqIdx).trim();
      const value = line
        .slice(eqIdx + 1)
        .trim()
        .replace(/^['"]|['"]$/g, '');
      if (process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // .env doesn't exist — fine for replay mode.
  }
}

function redactHeaders({
  headers,
}: {
  headers?: RedactableHeader[] | undefined;
}): RedactableHeader[] {
  if (!headers) return [];
  return headers.filter((h) => !DEFAULT_REDACT_HEADER_NAMES.has(h.name.toLowerCase()));
}

function redactCookies({
  cookies,
}: {
  cookies?: RedactableCookie[] | undefined;
}): RedactableCookie[] {
  if (!cookies) return [];
  return cookies.map((c) => ({ ...c, value: '[REDACTED]' }));
}

export function redactJsonValue({ value }: { value: unknown }): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue({ value: entry }));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      output[k] = REDACT_KEY_REGEX.test(k) ? '[REDACTED]' : redactJsonValue({ value: v });
    }
    return output;
  }
  if (typeof value === 'string') {
    return value.replace(REDACT_VALUE_REGEX, '[REDACTED-TOKEN]');
  }
  return value;
}

function redactDefaultText({ text }: { text: string }): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      return JSON.stringify(redactJsonValue({ value: JSON.parse(trimmed) }));
    } catch {
      // fall through
    }
  }
  return text.replace(REDACT_VALUE_REGEX, '[REDACTED-TOKEN]');
}

/**
 * Polly stores compressed-binary response bodies as base64 (sometimes
 * wrapped in a JSON-array of chunks). When the recording SDK is axios-based
 * (e.g. @slack/web-api), it sends `accept-encoding: gzip,br` regardless of
 * any fetch override we install, so responses arrive compressed and Polly
 * persists them as base64.
 *
 * `decompressIfNeeded` flattens that into plain text in-place: decode base64
 * → gunzip / brotli / inflate based on the `content-encoding` header → store
 * the plain text in `content.text`, drop `content.encoding`, strip the
 * content-encoding header so the patched adapter doesn't try to double-
 * decompress on replay (see /patches/@pollyjs__adapter-node-http@…).
 *
 * Crucially this runs BEFORE the per-package redactors so PII scrubbers see
 * plain JSON and can do their job.
 */
function decompressBase64Body({ content }: { content: RecordingContent }): Buffer | null {
  if (content.encoding !== 'base64' || typeof content.text !== 'string') return null;
  const trimmed = content.text.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('[')) {
    try {
      const parts: unknown = JSON.parse(trimmed);
      if (Array.isArray(parts) && parts.every((p) => typeof p === 'string')) {
        return Buffer.concat(parts.map((p) => Buffer.from(p as string, 'base64')));
      }
    } catch {
      // fall through to plain base64 decode
    }
  }
  try {
    return Buffer.from(trimmed, 'base64');
  } catch {
    return null;
  }
}

function decompressIfNeeded({ response }: { response: PollyRecording['response'] }): void {
  if (!response?.content || !Array.isArray(response.headers)) return;
  const buffer = decompressBase64Body({ content: response.content });
  if (!buffer) return;
  const encodingIdx = response.headers.findIndex(
    (h) => h.name.toLowerCase() === 'content-encoding',
  );
  if (encodingIdx < 0) {
    // No content-encoding header. The body is base64 binary that may or may
    // not be plain UTF-8 — try to decode and only commit if it round-trips.
    const text = buffer.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(buffer)) {
      response.content.text = text;
      delete response.content.encoding;
      response.content.size = text.length;
    }
    return;
  }
  const encoding = (response.headers[encodingIdx]?.value ?? '').toLowerCase();
  let decompressed: Buffer | null = null;
  try {
    if (encoding === 'gzip') decompressed = gunzipSync(buffer);
    else if (encoding === 'br') decompressed = brotliDecompressSync(buffer);
    else if (encoding === 'deflate') decompressed = inflateSync(buffer);
  } catch {
    return;
  }
  if (!decompressed) return;
  const text = decompressed.toString('utf8');
  response.headers.splice(encodingIdx, 1);
  delete response.content.encoding;
  response.content.text = text;
  response.content.size = text.length;
}

function isMissingReplayRecording({ error }: { error: unknown }): boolean {
  return (
    error instanceof Error &&
    error.message.includes('Recording for the following request is not found') &&
    error.message.includes('recordIfMissing') &&
    error.message.includes('false')
  );
}

/**
 * Wires up Polly + nock + node-fetch for the calling package's vitest run.
 * Returns nothing — registers `beforeEach` / `afterEach` / `afterAll` hooks
 * that fire for every test in the calling package.
 *
 * Call this exactly once from a package's vitest `setupFiles` entry. Calling
 * it twice will register the hooks twice and cause double-stop errors.
 */
export function definePollySetup({
  extraRedactors = [],
  extraRequestRewriter,
}: DefinePollySetupArgs = {}): void {
  loadDotEnvFromMonorepoRoot();

  const nativeFetch = globalThis.fetch;
  const POLLY_MODE = (process.env['POLLY_MODE'] ?? 'replay') as PollyConfig['mode'];

  if (POLLY_MODE !== 'passthrough') {
    // node-fetch v3 is ESM-only; top-level await is supported in vitest setup files.
    void (async () => {
      const { default: nodeFetchFn } = (await import('node-fetch')) as unknown as {
        default: typeof fetch;
      };
      globalThis.fetch = (async (
        input: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ): Promise<Response> => {
        const headers = new Headers(init?.headers);
        headers.set('accept-encoding', 'identity');
        let resolvedInput = input;
        if (POLLY_MODE === 'record' && extraRequestRewriter) {
          const urlString =
            typeof input === 'string' ? input : input instanceof URL ? input.toString() : null;
          if (urlString) {
            resolvedInput = extraRequestRewriter(urlString);
          }
        }
        return (await nodeFetchFn(resolvedInput, { ...init, headers })) as Response;
      }) as typeof fetch;
    })();
  }

  if (POLLY_MODE === 'record' || POLLY_MODE === 'passthrough') {
    nock.enableNetConnect();
  } else {
    nock.disableNetConnect();
    nock.enableNetConnect(
      (host) => host.includes('localhost') || host.includes('127.0.0.1') || host.includes('[::1]'),
    );
  }

  // Polly's `register` typing is overly strict against default-exported CJS
  // classes; the runtime call is fine.
  Polly.register(NodeHttpAdapter as never);
  Polly.register(FSPersister as never);

  let polly: Polly | null = null;
  let missingReplayRecordings: string[] = [];

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

    if (POLLY_MODE === 'passthrough') return;

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

    polly.server.any().on('beforePersist', (_req, recording: PollyRecording) => {
      // Decompress base64+gzip/br/deflate response bodies BEFORE any redactor
      // runs. SDKs that bypass our fetch override (axios-based @slack/web-api,
      // for one) send `accept-encoding: gzip,br` and Polly stores the raw
      // bytes as base64. Redactors that grep for tokens or parse JSON would
      // otherwise see opaque base64 and silently ship workspace data to disk.
      if (recording?.response) {
        decompressIfNeeded({ response: recording.response });
      }

      if (recording?.request) {
        if (Array.isArray(recording.request.headers)) {
          recording.request.headers = redactHeaders({ headers: recording.request.headers });
        }
        if (Array.isArray(recording.request.cookies)) {
          recording.request.cookies = redactCookies({ cookies: recording.request.cookies });
        }
        if (typeof recording.request.postData?.text === 'string') {
          recording.request.postData.text = redactDefaultText({
            text: recording.request.postData.text,
          });
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
          recording.response.content.text = redactDefaultText({
            text: recording.response.content.text,
          });
        }
      }
      // Per-package extra redactors run last so they see the fully-decompressed,
      // partially-cleaned recording and can apply platform-specific scrubbers.
      for (const extra of extraRedactors) {
        extra(recording);
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
}
