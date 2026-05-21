/**
 * `snapshot_profile` — copy a source file (typically a profile
 * markdown file such as `contexts/core-profile.md`) to a sortable,
 * timestamped path under a snapshots directory next to the source.
 * Used by `/retro` to preserve a versioned copy of the profile so
 * future retros can diff.
 *
 * Path contract: `source_path` may be absolute or relative. Relative
 * paths are resolved against `process.cwd()`. The snapshot lands at
 * `<source-dir>/profile-snapshots/<YYYY-MM-DDTHHMMSSZ>-<basename>`
 * by default. Same-day re-runs produce distinct files (the timestamp
 * has second-level precision) rather than silently overwriting. To
 * force a specific filename, pass `snapshot_name`.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { cwd as processCwd } from 'node:process';
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
      'Copy `source_path` to a sortable, timestamped snapshot in `<source-dir>/profile-snapshots/<YYYY-MM-DDTHHMMSSZ>-<basename>`. `source_path` may be absolute or relative (resolved via process.cwd()). Used by /retro to preserve a baseline for week-on-week diffs; same-day re-runs do not overwrite.',
    inputSchema: SnapshotProfileArgs,
    outputSchema: SnapshotProfileResult,
    handler: async ({ input }) => {
      const resolvedSourcePath = isAbsolute(input.source_path)
        ? input.source_path
        : resolve(processCwd(), input.source_path);
      let content: string;
      try {
        content = await readFile(resolvedSourcePath, 'utf-8');
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'snapshot_profile',
            undefined,
            `failed to read ${resolvedSourcePath}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      const nowMs = now();
      const timestamp = formatSortableTimestamp(new Date(nowMs));
      const filename = input.snapshot_name ?? `${timestamp}-${basename(resolvedSourcePath)}`;
      const snapshotDir = join(dirname(resolvedSourcePath), 'profile-snapshots');
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

/**
 * Sortable UTC timestamp suitable for filenames: `YYYY-MM-DDTHHMMSSZ`.
 * Differs from `toISOString()` in dropping the colons (illegal on
 * Windows / awkward in shell) and the milliseconds (not useful for
 * snapshots). Lexical sort matches chronological order.
 */
function formatSortableTimestamp(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  const ss = String(d.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}${mi}${ss}Z`;
}
