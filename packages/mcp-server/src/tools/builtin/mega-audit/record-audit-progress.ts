/**
 * `record_audit_progress` — append a JSONL progress event for the
 * current mega-audit run. The file lives at
 * `<data-dir>/audit-progress.jsonl` (where `<data-dir>` is the path
 * resolved by `@slopweaver/db`'s `resolveDataDir` — typically
 * `~/.slopweaver/`). The live UI from PR #61 tails this file.
 *
 * Tool stays standalone — the JSONL location is outside the work
 * console so this PR doesn't depend on the work-console plumbing in
 * PR #54.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RecordAuditProgressArgs, RecordAuditProgressResult } from '@slopweaver/contracts';
import { resolveDataDir } from '@slopweaver/db';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../../errors.ts';
import { defineTool, type Tool } from '../../registry.ts';

const PROGRESS_FILENAME = 'audit-progress.jsonl';

export type CreateRecordAuditProgressToolArgs = {
  /** Override the JSONL path (tests + non-default data dirs). */
  logPathOverride?: string;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
};

export function createRecordAuditProgressTool(args: CreateRecordAuditProgressToolArgs = {}): Tool {
  const now = args.now ?? Date.now;
  const logPathOverride = args.logPathOverride;

  return defineTool({
    name: 'record_audit_progress',
    description:
      'Append one progress event to the mega-audit JSONL log at <data-dir>/audit-progress.jsonl. Call from inside a mega-audit run for each phase transition so the live UI can tail the file. Cheap and idempotent at the file level (one append per call).',
    inputSchema: RecordAuditProgressArgs,
    outputSchema: RecordAuditProgressResult,
    handler: async ({ input }) => {
      const resolved =
        logPathOverride != null ? ok(logPathOverride) : resolveDataDir().map((dir) => join(dir, PROGRESS_FILENAME));
      if (resolved.isErr()) {
        return err(McpErrors.unexpected('record_audit_progress', undefined, resolved.error.message));
      }
      const logPath = resolved.value;

      const line: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        audit_id: input.audit_id,
        phase: input.phase,
        message: input.message,
      };
      if (input.source !== undefined) line['source'] = input.source;
      if (input.pct !== undefined) line['pct'] = input.pct;
      const encoded = `${JSON.stringify(line)}\n`;

      // Count existing lines for the 1-based line-number return value.
      // Identical pattern to log_walk_feedback / append_daily_journal —
      // read-then-append. Read failure (ENOENT) is treated as 0.
      let existingLines = 0;
      try {
        const content = await readFile(logPath, 'utf-8');
        existingLines = content.split('\n').filter((l) => l.trim().length > 0).length;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          return err(
            McpErrors.unexpected(
              'record_audit_progress',
              undefined,
              `failed to read ${logPath}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      }

      // Ensure parent dir + append. We use writeFile with the 'a' flag
      // via `appendFile`, but to keep behaviour explicit + testable we
      // append by read-then-write (same pattern as the walk-feedback
      // log helper). On a fresh log, that's a single write.
      const parent = dirname(logPath);
      try {
        await mkdir(parent, { recursive: true });
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'record_audit_progress',
            undefined,
            `failed to mkdir ${parent}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      let next = encoded;
      try {
        const existing = await stat(logPath);
        if (existing.isFile()) {
          const prev = await readFile(logPath, 'utf-8');
          next = prev.endsWith('\n') || prev.length === 0 ? `${prev}${encoded}` : `${prev}\n${encoded}`;
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          return err(
            McpErrors.unexpected(
              'record_audit_progress',
              undefined,
              `failed to stat ${logPath}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      }
      try {
        await writeFile(logPath, next, { encoding: 'utf-8', mode: 0o644 });
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'record_audit_progress',
            undefined,
            `failed to write ${logPath}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      return ok({
        log_path: logPath,
        line_number: existingLines + 1,
        bytes_appended: Buffer.byteLength(encoded, 'utf-8'),
      });
    },
  });
}
