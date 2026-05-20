import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SnapshotProfileArgs, SnapshotProfileResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshotProfileTool } from './snapshot-profile.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 0, 0);

describe('createSnapshotProfileTool', () => {
  let dbHandle: ReturnType<typeof createDb>;
  let tempDir: string;
  let sourcePath: string;

  beforeEach(() => {
    dbHandle = createDb({ path: ':memory:' });
    tempDir = mkdtempSync(join(tmpdir(), 'slop-retro-'));
    sourcePath = join(tempDir, 'core-profile.md');
    writeFileSync(sourcePath, '# profile content\n');
  });

  afterEach(() => {
    dbHandle.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes a snapshot to <source-dir>/profile-snapshots/<date>-<basename>', async () => {
    const tool = createSnapshotProfileTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: SnapshotProfileArgs.parse({ source_path: sourcePath }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = SnapshotProfileResult.parse(result.value);
      expect(parsed.snapshot_path).toBe(join(tempDir, 'profile-snapshots', '2026-05-21-core-profile.md'));
      expect(parsed.bytes_written).toBe(Buffer.byteLength('# profile content\n', 'utf-8'));
      expect(readFileSync(parsed.snapshot_path, 'utf-8')).toBe('# profile content\n');
    }
  });

  it('honours an explicit snapshot_name', async () => {
    const tool = createSnapshotProfileTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: SnapshotProfileArgs.parse({ source_path: sourcePath, snapshot_name: 'baseline.md' }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.snapshot_path).toBe(join(tempDir, 'profile-snapshots', 'baseline.md'));
    }
  });

  it('errors when the source file is missing', async () => {
    const tool = createSnapshotProfileTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: SnapshotProfileArgs.parse({ source_path: join(tempDir, 'missing.md') }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isErr()).toBe(true);
    if (result.isErr()) expect(result.error.message).toContain('failed to read');
  });
});
