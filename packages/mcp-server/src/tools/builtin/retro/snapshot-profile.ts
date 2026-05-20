/**
 * `snapshot_profile` — copy a source file (typically
 * `contexts/core-profile.md`) to a timestamped path under a
 * snapshots directory next to the source. Used by `/retro` to
 * preserve a versioned copy of the profile so future retros can diff.
 *
 * Path layout: `<source-dir>/profile-snapshots/<date>-<basename>`.
 * Idempotent on same-day re-runs (later writes overwrite).
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { SnapshotProfileArgs, SnapshotProfileResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../../errors.ts';
import { defineTool, type Tool } from '../../registry.ts';

export type CreateSnapshotProfileToolArgs = {
  now?: () => number;
};

export function createSnapshotProfileTool(args: CreateSnapshotProfileToolArgs = {}): Tool {
  const now = args.now ?? Date.now;

  return defineTool({
    name: 'snapshot_profile',
    description:
      'Copy `source_path` to a versioned snapshot in `<source-dir>/profile-snapshots/<date>-<basename>`. Used by /retro to preserve a baseline for week-on-week diffs. Idempotent on same-day re-runs.',
    inputSchema: SnapshotProfileArgs,
    outputSchema: SnapshotProfileResult,
    handler: async ({ input }) => {
      let content: string;
      try {
        content = await readFile(input.source_path, 'utf-8');
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'snapshot_profile',
            undefined,
            `failed to read ${input.source_path}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      const nowMs = now();
      const date = new Date(nowMs).toISOString().slice(0, 10);
      const filename = input.snapshot_name ?? `${date}-${basename(input.source_path)}`;
      const snapshotDir = join(dirname(input.source_path), 'profile-snapshots');
      const snapshotPath = join(snapshotDir, filename);
      try {
        await mkdir(snapshotDir, { recursive: true });
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'snapshot_profile',
            undefined,
            `failed to mkdir ${snapshotDir}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      try {
        await writeFile(snapshotPath, content, { encoding: 'utf-8', mode: 0o644 });
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'snapshot_profile',
            undefined,
            `failed to write ${snapshotPath}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      return ok({
        snapshot_path: snapshotPath,
        bytes_written: Buffer.byteLength(content, 'utf-8'),
        generated_at: new Date(nowMs).toISOString(),
      });
    },
  });
}
