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
});
