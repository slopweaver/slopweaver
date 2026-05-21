/**
 * Pure-function tests for `start_mega_audit`. Verifies that the
 * instructional body is the expected immutable template (modulo the
 * SINCE_DATE substitution), that defaulting works as documented, and
 * that the wire-contract holds via Zod.
 */

import { StartMegaAuditArgs, StartMegaAuditResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStartMegaAuditTool } from './start-mega-audit.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0); // 2026-05-21T10:00:00Z
const NINETY_DAYS_BACK = '2026-02-20';

describe('createStartMegaAuditTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('defaults the lookback window to 90 days back and supplies a budget', async () => {
    const tool = createStartMegaAuditTool({
      now: () => FIXED_NOW,
      generateAuditId: () => 'audit_fixed_demo',
    });
    const result = await tool.handler({
      input: StartMegaAuditArgs.parse({}),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = StartMegaAuditResult.parse(result.value);
      expect(parsed.audit_id).toBe('audit_fixed_demo');
      expect(parsed.since).toBe(NINETY_DAYS_BACK);
      expect(parsed.per_source_token_budget).toBe(90_000);
      expect(parsed.generated_at).toBe(new Date(FIXED_NOW).toISOString());
      expect(parsed.instructions).toContain(NINETY_DAYS_BACK);
      expect(parsed.instructions).toContain('Phase 0 — Branch + bootstrap');
      expect(parsed.instructions).toContain('Phase 5 — Write');
    }
  });

  it('honours an explicit `since` and `per_source_token_budget`', async () => {
    const tool = createStartMegaAuditTool({
      now: () => FIXED_NOW,
      generateAuditId: () => 'audit_custom',
    });
    const result = await tool.handler({
      input: StartMegaAuditArgs.parse({
        since: '2025-12-01',
        per_source_token_budget: 50_000,
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = StartMegaAuditResult.parse(result.value);
      expect(parsed.since).toBe('2025-12-01');
      expect(parsed.per_source_token_budget).toBe(50_000);
      expect(parsed.instructions).toContain('2025-12-01');
    }
  });

  it('generates distinct audit_ids by default', async () => {
    const tool = createStartMegaAuditTool({ now: () => FIXED_NOW });
    const a = await tool.handler({ input: StartMegaAuditArgs.parse({}), ctx: { db: dbHandle.db } });
    const b = await tool.handler({ input: StartMegaAuditArgs.parse({}), ctx: { db: dbHandle.db } });
    expect(a.isOk()).toBe(true);
    expect(b.isOk()).toBe(true);
    if (a.isOk() && b.isOk()) {
      expect(a.value['audit_id']).not.toBe(b.value['audit_id']);
    }
  });

  it('defaults to a UUID-suffixed id with a date prefix', async () => {
    // The default generator uses crypto.randomUUID() for the suffix
    // (122 bits of entropy) instead of Math.random(). Assert the
    // shape: `audit_YYYYMMDD_<32-hex-chars>`. The 32-hex shape
    // matches a UUID-without-dashes; if the implementation regresses
    // to a 6-char Math.random suffix this test fails on length.
    const tool = createStartMegaAuditTool({ now: () => FIXED_NOW });
    const result = await tool.handler({ input: StartMegaAuditArgs.parse({}), ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value['audit_id']).toMatch(/^audit_\d{8}_[0-9a-f]{32}$/);
    }
  });
});
