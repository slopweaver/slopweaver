/**
 * `record_send_outcome` — append a JSONL entry to
 * `<data-dir>/sends.jsonl` recording the outcome of an attempted send.
 *
 * Companion to `prepare_send`. The model calls this after invoking the
 * source-platform send tool — once for success, once for failure, once
 * for user-cancelled-via-undo. Plays the same role for sends that
 * `log_walk_feedback` plays for /lock-in walks: durable training data
 * for the calibration loop.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RecordSendOutcomeArgs, RecordSendOutcomeResult } from '@slopweaver/contracts';
import { resolveDataDir } from '@slopweaver/db';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../../errors.ts';
import { defineTool, type Tool } from '../../registry.ts';

const SENDS_LOG_FILENAME = 'sends.jsonl';

export type CreateRecordSendOutcomeToolArgs = {
  /** Override the JSONL path (tests). */
  logPathOverride?: string;
  /** Clock injection for tests. */
  now?: () => number;
};

export function createRecordSendOutcomeTool(args: CreateRecordSendOutcomeToolArgs = {}): Tool {
  const now = args.now ?? Date.now;
  const logPathOverride = args.logPathOverride;

  return defineTool({
    name: 'record_send_outcome',
    description:
      'Append one outcome entry to <data-dir>/sends.jsonl. Call after `prepare_send` + the actual send tool to record what happened (sent / failed / cancelled). Required for the calibration loop to track send hit-rate.',
    inputSchema: RecordSendOutcomeArgs,
    outputSchema: RecordSendOutcomeResult,
    handler: async ({ input }) => {
      const resolved =
        logPathOverride != null ? ok(logPathOverride) : resolveDataDir().map((dir) => join(dir, SENDS_LOG_FILENAME));
      if (resolved.isErr()) {
        return err(McpErrors.unexpected('record_send_outcome', undefined, resolved.error.message));
      }
      const logPath = resolved.value;

      const line: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        draft_path: input.draft_path,
        status: input.status,
      };
      if (input.sent_url !== undefined) line['sent_url'] = input.sent_url;
      if (input.error !== undefined) line['error'] = input.error;
      const encoded = `${JSON.stringify(line)}\n`;

      let existingLines = 0;
      try {
        const content = await readFile(logPath, 'utf-8');
        existingLines = content.split('\n').filter((l) => l.trim().length > 0).length;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          return err(
            McpErrors.unexpected(
              'record_send_outcome',
              undefined,
              `failed to read ${logPath}: ${e instanceof Error ? e.message : String(e)}`,
            ),
          );
        }
      }

      const parent = dirname(logPath);
      try {
        await mkdir(parent, { recursive: true });
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'record_send_outcome',
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
              'record_send_outcome',
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
            'record_send_outcome',
            undefined,
            `failed to write ${logPath}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      return ok({
        log_path: logPath,
        line_number: existingLines + 1,
      });
    },
  });
}
