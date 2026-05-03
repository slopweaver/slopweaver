import { describe, expect, it } from 'vitest';
import {
  EvidenceLogEntry,
  Freshness,
  PingArgs,
  PingResult,
  Reference,
  StartSessionArgs,
  StartSessionResult,
} from './index.ts';

describe('contracts surface', () => {
  it('exports the v1 schema surface', () => {
    expect(PingArgs).toBeDefined();
    expect(PingResult).toBeDefined();
    expect(Reference).toBeDefined();
    expect(Freshness).toBeDefined();
    expect(EvidenceLogEntry).toBeDefined();
    expect(StartSessionArgs).toBeDefined();
    expect(StartSessionResult).toBeDefined();
  });
});

describe('PingResult', () => {
  it('safeParses the v1 mcp-server ping response shape', () => {
    const result = PingResult.safeParse({
      ok: true,
      version: '0.1.0',
      uptime_s: 42,
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        ok: true,
        version: '0.1.0',
        uptime_s: 42,
      });
    }
  });

  it('rejects negative uptime_s', () => {
    const result = PingResult.safeParse({
      ok: true,
      version: '0.1.0',
      uptime_s: -1,
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown extra props (strict)', () => {
    const result = PingResult.safeParse({
      ok: true,
      version: '0.1.0',
      uptime_s: 0,
      extra: 'not allowed',
    });

    expect(result.success).toBe(false);
  });
});

describe('Reference', () => {
  it('accepts url variant', () => {
    const result = Reference.safeParse({
      kind: 'url',
      url: 'https://github.com/slopweaver/slopweaver/pull/24',
    });
    expect(result.success).toBe(true);
  });

  it('accepts canonical variant', () => {
    const result = Reference.safeParse({
      kind: 'canonical',
      integration: 'github',
      id: 'pr/24',
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown discriminant', () => {
    const result = Reference.safeParse({
      kind: 'something-else',
      url: 'https://example.com',
    });
    expect(result.success).toBe(false);
  });

  it('rejects mixed-shape inputs', () => {
    const result = Reference.safeParse({
      kind: 'url',
      integration: 'github',
      id: 'pr/24',
    });
    expect(result.success).toBe(false);
  });
});

describe('Freshness', () => {
  it('accepts a never-polled-yet integration with last_polled_at: null', () => {
    const result = Freshness.safeParse({
      integration: 'github',
      last_polled_at: null,
      stale: true,
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing last_polled_at field', () => {
    const result = Freshness.safeParse({
      integration: 'github',
      stale: true,
    });
    expect(result.success).toBe(false);
  });
});

describe('EvidenceLogEntry', () => {
  it('accepts payload_json as an object', () => {
    const result = EvidenceLogEntry.safeParse({
      id: 'gh:pr:24',
      integration: 'github',
      kind: 'pull_request',
      ref: { kind: 'canonical', integration: 'github', id: 'pr/24' },
      occurred_at: '2026-05-03T18:00:00+10:00',
      payload_json: { title: 'feat(contracts)', state: 'open' },
      citation_url: 'https://github.com/slopweaver/slopweaver/pull/24',
    });
    expect(result.success).toBe(true);
  });

  it('accepts payload_json as an array (any JSON value)', () => {
    const result = EvidenceLogEntry.safeParse({
      id: 'gh:commit:abc',
      integration: 'github',
      kind: 'commit',
      ref: { kind: 'url', url: 'https://github.com/slopweaver/slopweaver/commit/abc' },
      occurred_at: '2026-05-03T18:00:00+10:00',
      payload_json: ['file1.ts', 'file2.ts'],
      citation_url: null,
    });
    expect(result.success).toBe(true);
  });
});
