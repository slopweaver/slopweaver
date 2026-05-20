/**
 * Tests for `append_daily_journal`. Covers: first-write creates the file
 * with frontmatter, second append leaves frontmatter intact and adds the
 * new stanza, explicit `date` arg overrides the clock.
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppendDailyJournalArgs, AppendDailyJournalResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { createAppendDailyJournalTool } from './append-daily-journal.ts';

describe('createAppendDailyJournalTool', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let tempCwd: string;
  let config: WorkConsoleConfig;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempCwd = mkdtempSync(join(tmpdir(), 'slop-journal-'));
    config = resolveWorkConsoleConfig({ cwd: tempCwd, consoleRelDir: '.console' });
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(tempCwd, { recursive: true, force: true });
  });

  it('creates a new daily file with a frontmatter on first append', async () => {
    const tool = createAppendDailyJournalTool({
      config,
      now: () => new Date(2026, 4, 21, 10, 0, 0), // 2026-05-21 local
    });
    const result = await tool.handler({
      input: AppendDailyJournalArgs.parse({
        heading: 'Session start',
        body: 'Walked 5 items, locked in 2.',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = AppendDailyJournalResult.parse(result.value);
      expect(parsed.path.endsWith('/daily/2026-05/21.md')).toBe(true);
      expect(parsed.created).toBe(true);
      const onDisk = readFileSync(parsed.path, 'utf-8');
      expect(onDisk).toContain('---\ndate: 2026-05-21\n---');
      expect(onDisk).toContain('## Session start');
      expect(onDisk).toContain('Walked 5 items, locked in 2.');
    }
  });

  it('appends a second stanza without touching the frontmatter', async () => {
    const tool = createAppendDailyJournalTool({
      config,
      now: () => new Date(2026, 4, 21, 10, 0, 0),
    });
    await tool.handler({
      input: AppendDailyJournalArgs.parse({ heading: 'Morning', body: 'first stanza' }),
      ctx: { db: dbHandle.db },
    });
    const second = await tool.handler({
      input: AppendDailyJournalArgs.parse({ heading: 'Afternoon', body: 'second stanza' }),
      ctx: { db: dbHandle.db },
    });
    expect(second.isOk()).toBe(true);
    if (second.isOk()) {
      const parsed = AppendDailyJournalResult.parse(second.value);
      expect(parsed.created).toBe(false);
      const onDisk = readFileSync(parsed.path, 'utf-8');
      expect(onDisk).toContain('---\ndate: 2026-05-21\n---');
      expect(onDisk).toContain('## Morning');
      expect(onDisk).toContain('first stanza');
      expect(onDisk).toContain('## Afternoon');
      expect(onDisk).toContain('second stanza');
      // The frontmatter must remain at the top once.
      expect((onDisk.match(/---\ndate:/g) ?? []).length).toBe(1);
    }
  });

  it('respects the explicit date argument', async () => {
    const tool = createAppendDailyJournalTool({
      config,
      now: () => new Date(2026, 4, 21, 10, 0, 0),
    });
    const result = await tool.handler({
      input: AppendDailyJournalArgs.parse({
        heading: 'Late note',
        body: 'something I forgot',
        date: '2026-04-15',
      }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = AppendDailyJournalResult.parse(result.value);
      expect(parsed.path.endsWith('/daily/2026-04/15.md')).toBe(true);
    }
  });
});
