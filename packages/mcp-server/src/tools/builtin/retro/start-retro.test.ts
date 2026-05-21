import { StartRetroArgs, StartRetroResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStartRetroTool } from './start-retro.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);
const SEVEN_DAYS_BACK = '2026-05-14';

describe('createStartRetroTool', () => {
  let dbHandle: ReturnType<typeof createDb>;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
  });

  afterEach(() => {
    dbHandle.close();
  });

  it('defaults the since window to 7 days back', async () => {
    const tool = createStartRetroTool({ now: () => FIXED_NOW, generateRetroId: () => 'retro_fixed' });
    const result = await tool.handler({ input: StartRetroArgs.parse({}), ctx: { db: dbHandle.db } });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = StartRetroResult.parse(result.value);
      expect(parsed.retro_id).toBe('retro_fixed');
      expect(parsed.since).toBe(SEVEN_DAYS_BACK);
      expect(parsed.instructions).toContain('Weekly retro');
      expect(parsed.instructions).toContain('snapshot_profile');
      expect(parsed.instructions).toContain('catch_me_up');
      // The prompt must only reference tools registered in this build.
      expect(parsed.instructions).not.toContain('list_console_files');
      expect(parsed.instructions).not.toContain('get_calibration_report');
      // No private-repo PR references must leak into the user-facing prompt.
      expect(parsed.instructions).not.toContain('#54');
    }
  });

  it('honours an explicit since arg', async () => {
    const tool = createStartRetroTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: StartRetroArgs.parse({ since: '2026-01-01' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = StartRetroResult.parse(result.value);
      expect(parsed.since).toBe('2026-01-01');
    }
  });
});
