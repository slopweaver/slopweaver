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
 *
 * Safety: `snapshot_name` is constrained to a single filename — no
 * path separators, no `..` segments, no absolute paths. Any value
 * that would resolve outside `<source-dir>/profile-snapshots/` is
 * rejected with `MCP_SNAPSHOT_NAME_INVALID` so a caller can't
 * traverse back over the source profile or anywhere else on disk.
 * If the resolved destination already exists, the tool refuses to
 * write with `MCP_SNAPSHOT_EXISTS` unless `overwrite: true` is set.
 */

import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { cwd as processCwd } from 'node:process';
import { SnapshotProfileArgs, SnapshotProfileResult } from '@slopweaver/contracts';
import { err, ok, type Result } from '@slopweaver/errors';
import { type McpToolError, McpErrors } from '../../../errors.ts';
import { defineTool, type Tool } from '../../registry.ts';

export type CreateSnapshotProfileToolArgs = {
  now?: () => number;
};

export function createSnapshotProfileTool(args: CreateSnapshotProfileToolArgs = {}): Tool {
  const now = args.now ?? Date.now;

  return defineTool({
    name: 'snapshot_profile',
    description:
      'Copy `source_path` to a sortable, timestamped snapshot in `<source-dir>/profile-snapshots/<YYYY-MM-DDTHHMMSSZ>-<basename>`. `source_path` may be absolute or relative (resolved via process.cwd()). Used by /retro to preserve a baseline for week-on-week diffs. `snapshot_name` must be a bare filename (no separators, no `..`); the tool refuses to overwrite an existing snapshot unless `overwrite: true`.',
    inputSchema: SnapshotProfileArgs,
    outputSchema: SnapshotProfileResult,
    handler: async ({ input }) => {
      const resolvedSourcePath = isAbsolute(input.source_path)
        ? input.source_path
        : resolve(processCwd(), input.source_path);
      const snapshotDir = join(dirname(resolvedSourcePath), 'profile-snapshots');
      const nowMs = now();
      const timestamp = formatSortableTimestamp(new Date(nowMs));
      const defaultFilename = `${timestamp}-${basename(resolvedSourcePath)}`;
      const filename = input.snapshot_name ?? defaultFilename;

      if (input.snapshot_name !== undefined) {
        const validation = validateSnapshotName({
          snapshotName: input.snapshot_name,
          snapshotDir,
        });
        if (validation.isErr()) return err(validation.error);
      }

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

      const snapshotPath = join(snapshotDir, filename);

      if (input.overwrite !== true && (await fileExists(snapshotPath))) {
        return err(McpErrors.snapshotExists({ snapshotPath }));
      }

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
 * Reject `snapshot_name` values that contain path separators, `..`
 * segments, or that resolve outside `snapshotDir`. The check is
 * defence-in-depth — the literal-character checks catch the common
 * cases without needing FS access, and the `path.resolve` check
 * catches anything platform-specific (e.g. Windows drive letters)
 * that slips past.
 */
function validateSnapshotName({
  snapshotName,
  snapshotDir,
}: {
  snapshotName: string;
  snapshotDir: string;
}): Result<true, McpToolError> {
  if (snapshotName.includes('/') || snapshotName.includes('\\')) {
    return err(
      McpErrors.snapshotNameInvalid({
        snapshotName,
        reason: 'snapshot_name must be a bare filename (no path separators)',
      }),
    );
  }
  if (snapshotName === '..' || snapshotName === '.' || snapshotName.includes('..')) {
    return err(
      McpErrors.snapshotNameInvalid({
        snapshotName,
        reason: 'snapshot_name must not contain `..` segments',
      }),
    );
  }
  if (isAbsolute(snapshotName)) {
    return err(
      McpErrors.snapshotNameInvalid({
        snapshotName,
        reason: 'snapshot_name must not be an absolute path',
      }),
    );
  }
  const resolvedDir = resolve(snapshotDir);
  const resolvedTarget = resolve(snapshotDir, snapshotName);
  if (resolvedTarget !== resolvedDir && !resolvedTarget.startsWith(resolvedDir + sep)) {
    return err(
      McpErrors.snapshotNameInvalid({
        snapshotName,
        reason: 'snapshot_name resolves outside the profile-snapshots directory',
      }),
    );
  }
  return ok(true);
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
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
