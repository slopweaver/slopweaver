/**
 * `record_audit_progress` — append a JSONL progress event for the
 * current mega-audit run. One file per `audit_id` lives under
 * `<data-dir>/audit-progress/<audit_id>.jsonl` (where `<data-dir>` is
 * the path resolved by `@slopweaver/db`'s `resolveDataDir` — typically
 * `~/.slopweaver/`). The live UI from PR #61 tails the matching file.
 *
 * The per-`audit_id` layout is deliberate: it lets us use true append
 * semantics (`O_APPEND`) without races between concurrent audits, and
 * it lets us count lines from the file's own size without coordinating
 * with other audits' writes. A shared file would force a
 * read-modify-write that races on every concurrent call.
 *
 * Tool stays standalone — the JSONL location is outside the work
 * console so this PR doesn't depend on the work-console plumbing in
 * PR #54.
 */

import { constants as fsConstants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RecordAuditProgressArgs, RecordAuditProgressResult } from '@slopweaver/contracts';
import { resolveDataDir } from '@slopweaver/db';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../../errors.ts';
import { defineTool, type Tool } from '../../registry.ts';

const PROGRESS_DIRNAME = 'audit-progress';

export type CreateRecordAuditProgressToolArgs = {
  /** Override the JSONL directory (tests + non-default data dirs). */
  logDirOverride?: string;
  /** Clock injection for tests. Defaults to `Date.now`. */
  now?: () => number;
};

/**
 * Reject any audit_id containing path separators or path-traversal
 * segments. The id flows straight into a filename; treat it as
 * adversarial input and refuse anything that could escape the audit
 * directory.
 */
function isSafeAuditId(auditId: string): boolean {
  if (auditId.length === 0 || auditId.length > 128) return false;
  if (auditId.includes('/') || auditId.includes('\\')) return false;
  if (auditId === '.' || auditId === '..') return false;
  // Conservative whitelist: alphanumerics, `_`, `-`, `.` (date prefix +
  // UUID is the only shape the start_mega_audit generator produces).
  return /^[A-Za-z0-9._-]+$/.test(auditId);
}

export function createRecordAuditProgressTool(args: CreateRecordAuditProgressToolArgs = {}): Tool {
  const now = args.now ?? Date.now;
  const logDirOverride = args.logDirOverride;

  return defineTool({
    name: 'record_audit_progress',
    description:
      'Append one progress event to the per-audit JSONL log at <data-dir>/audit-progress/<audit_id>.jsonl. Call from inside a mega-audit run for each phase transition so the live UI can tail the file. Uses O_APPEND for race-free concurrent appends; the per-audit_id layout means concurrent audits never contend on the same file.',
    inputSchema: RecordAuditProgressArgs,
    outputSchema: RecordAuditProgressResult,
    handler: async ({ input }) => {
      if (!isSafeAuditId(input.audit_id)) {
        return err(
          McpErrors.unexpected(
            'record_audit_progress',
            undefined,
            `audit_id must be 1-128 chars of [A-Za-z0-9._-]; got "${input.audit_id}"`,
          ),
        );
      }

      const dirResult =
        logDirOverride != null ? ok(logDirOverride) : resolveDataDir().map((dir) => join(dir, PROGRESS_DIRNAME));
      if (dirResult.isErr()) {
        return err(McpErrors.unexpected('record_audit_progress', undefined, dirResult.error.message));
      }
      const logDir = dirResult.value;
      const logPath = join(logDir, `${input.audit_id}.jsonl`);

      const line: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        audit_id: input.audit_id,
        phase: input.phase,
        message: input.message,
      };
      if (input.source !== undefined) line['source'] = input.source;
      if (input.pct !== undefined) line['pct'] = input.pct;
      const encoded = `${JSON.stringify(line)}\n`;
      const encodedBytes = Buffer.from(encoded, 'utf-8');

      // Ensure parent dir before the open(O_APPEND | O_CREAT) below.
      // `dirname(logPath)` is always `logDir` in the happy path but the
      // explicit dirname call keeps this robust if the layout changes.
      try {
        await mkdir(dirname(logPath), { recursive: true });
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'record_audit_progress',
            undefined,
            `failed to mkdir ${dirname(logPath)}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }

      // True append: O_APPEND guarantees atomic positioning for writes
      // up to PIPE_BUF (4KB on Linux, 512B on macOS). Progress events
      // are tens of bytes, so a single write is atomic and lock-free
      // against concurrent appenders to the same file. Combined with
      // the per-audit_id filename, this is race-free across concurrent
      // audits too — and crucially, same-audit parallel callers also
      // appear in arbitrary order without corrupting each other's bytes.
      //
      // We deliberately do not derive a `line_number` after the write.
      // A read-then-count from the same descriptor would observe other
      // concurrent appenders' lines, so two parallel callers could see
      // the same final length and report the same line number — the
      // returned value would no longer identify the caller's own event.
      // The caller doesn't need it; the live UI tails the file directly.
      const fh = await open(logPath, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT, 0o644).catch(
        (e: unknown) => {
          return new Error(`failed to open ${logPath}: ${e instanceof Error ? e.message : String(e)}`);
        },
      );
      if (fh instanceof Error) {
        return err(McpErrors.unexpected('record_audit_progress', undefined, fh.message));
      }

      try {
        const writeResult = await fh.write(encodedBytes);
        if (writeResult.bytesWritten !== encodedBytes.length) {
          return err(
            McpErrors.unexpected(
              'record_audit_progress',
              undefined,
              `short write to ${logPath}: wrote ${writeResult.bytesWritten} of ${encodedBytes.length} bytes`,
            ),
          );
        }
        return ok({
          log_path: logPath,
          bytes_appended: encodedBytes.length,
        });
      } finally {
        await fh.close().catch(() => {
          // Close errors are non-fatal — the write already succeeded
          // and the OS reclaims the descriptor on process exit. We
          // can't surface a typed error from a finally block without
          // overriding the actual return value, so swallow.
        });
      }
    },
  });
}
