import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { SnapshotProfileArgs, SnapshotProfileResult } from '@slopweaver/contracts';
import { createDb } from '@slopweaver/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSnapshotProfileTool } from './snapshot-profile.ts';

const FIXED_NOW = Date.UTC(2026, 4, 21, 10, 5, 30);
const FIXED_TIMESTAMP = '2026-05-21T100530Z';

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

  it('writes a sortable timestamped snapshot to <source-dir>/profile-snapshots/<ts>-<basename>', async () => {
    const tool = createSnapshotProfileTool({ now: () => FIXED_NOW });
    const result = await tool.handler({
      input: SnapshotProfileArgs.parse({ source_path: sourcePath }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = SnapshotProfileResult.parse(result.value);
      expect(parsed.snapshot_path).toBe(join(tempDir, 'profile-snapshots', `${FIXED_TIMESTAMP}-core-profile.md`));
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
      const parsed = SnapshotProfileResult.parse(result.value);
      expect(parsed.snapshot_path).toBe(join(tempDir, 'profile-snapshots', 'baseline.md'));
    }
  });

  it('resolves a relative source_path against process.cwd()', async () => {
    const tool = createSnapshotProfileTool({ now: () => FIXED_NOW });
    const relativeSourcePath = relative(processCwd(), sourcePath);
    const result = await tool.handler({
      input: SnapshotProfileArgs.parse({ source_path: relativeSourcePath }),
      ctx: { db: dbHandle.db },
    });
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const parsed = SnapshotProfileResult.parse(result.value);
      expect(parsed.snapshot_path).toBe(join(tempDir, 'profile-snapshots', `${FIXED_TIMESTAMP}-core-profile.md`));
      expect(readFileSync(parsed.snapshot_path, 'utf-8')).toBe('# profile content\n');
    }
  });

  it('does not overwrite earlier snapshots when run twice on the same day', async () => {
    const firstTool = createSnapshotProfileTool({ now: () => FIXED_NOW });
    const firstResult = await firstTool.handler({
      input: SnapshotProfileArgs.parse({ source_path: sourcePath }),
      ctx: { db: dbHandle.db },
    });
    expect(firstResult.isOk()).toBe(true);

    // A later call (same day, different second) produces a distinct path.
    const laterMs = FIXED_NOW + 5_000;
    const secondTool = createSnapshotProfileTool({ now: () => laterMs });
    writeFileSync(sourcePath, '# updated content\n');
    const secondResult = await secondTool.handler({
      input: SnapshotProfileArgs.parse({ source_path: sourcePath }),
      ctx: { db: dbHandle.db },
    });
    expect(secondResult.isOk()).toBe(true);

    if (firstResult.isOk() && secondResult.isOk()) {
      const firstParsed = SnapshotProfileResult.parse(firstResult.value);
      const secondParsed = SnapshotProfileResult.parse(secondResult.value);
      expect(firstParsed.snapshot_path).not.toBe(secondParsed.snapshot_path);
      expect(readFileSync(firstParsed.snapshot_path, 'utf-8')).toBe('# profile content\n');
      expect(readFileSync(secondParsed.snapshot_path, 'utf-8')).toBe('# updated content\n');
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
