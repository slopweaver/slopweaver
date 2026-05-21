/**
 * `record_send_outcome` — durable record of an attempted send.
 *
 * Companion to `prepare_send`. The model calls this after invoking the
 * source-platform send tool — once for success, once for failure, once
 * for user-cancelled-via-undo. Plays the same role for sends that
 * `log_walk_feedback` plays for /lock-in walks: durable training data
 * for the calibration loop.
 *
 * Responsibilities (Codex P1):
 *  1. Load the draft file at `draft_path`.
 *  2. Validate the draft still matches what `prepare_send` saw —
 *     same `draft_id`, same `content_hash` (covering frontmatter +
 *     body). Mismatch ⇒ drift, reject the call so the calibration
 *     log can't be poisoned with a payload that no longer matches
 *     the draft on disk.
 *  3. Atomically rewrite the draft's `status:` field (temp-file +
 *     rename, never an in-place write). Reject repeat calls that would
 *     overwrite a terminal status with a different terminal status —
 *     `cancelled` -> `sent` is meaningless.
 *  4. Append a JSONL entry to `<data-dir>/sends.jsonl` for calibration.
 *     Idempotent on `(draft_id, status, content_hash)` — repeat calls
 *     with the same triple return the existing line_number without
 *     writing a new row, so a retry after transport ambiguity can't
 *     double-count calibration data.
 *
 * `safeQuery`/Result patterns from `@slopweaver/errors` are used at the
 * boundary; the tool itself uses local `try/catch` around fs calls to
 * map into the McpToolError union per
 * `.claude/rules/error-handling.md` (the service-boundary scanner only
 * flags `throw` statements; classification catches are allowed).
 */

import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { RecordSendOutcomeArgs, RecordSendOutcomeResult } from '@slopweaver/contracts';
import { resolveDataDir } from '@slopweaver/db';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../../errors.ts';
import { defineTool, type Tool } from '../../registry.ts';
import { hashContent, parseFrontmatter, serializeDraft } from './parse-frontmatter.ts';

const SENDS_LOG_FILENAME = 'sends.jsonl';

const TERMINAL_STATUSES = new Set(['sent', 'failed', 'cancelled']);

export type CreateRecordSendOutcomeToolArgs = {
  /** Override the JSONL path (tests). */
  logPathOverride?: string;
  /** Clock injection for tests. */
  now?: () => number;
  /** Override the fs reader (tests). */
  readFileImpl?: (path: string) => Promise<string>;
  /** Override the fs writer (tests). */
  writeFileImpl?: (path: string, content: string) => Promise<void>;
  /** Override the atomic rename (tests). */
  renameImpl?: (from: string, to: string) => Promise<void>;
};

export function createRecordSendOutcomeTool(args: CreateRecordSendOutcomeToolArgs = {}): Tool {
  const now = args.now ?? Date.now;
  const logPathOverride = args.logPathOverride;
  const readImpl = args.readFileImpl ?? ((p) => readFile(p, 'utf-8'));
  const writeImpl = args.writeFileImpl ?? ((p, content) => writeFile(p, content, { encoding: 'utf-8', mode: 0o644 }));
  const renameFn = args.renameImpl ?? rename;

  return defineTool({
    name: 'record_send_outcome',
    description:
      'Record the outcome of a send attempt. Loads the draft at `draft_path`, validates `draft_id` + `content_hash` (frontmatter + body) still match what `prepare_send` saw (drift detection), atomically rewrites the draft frontmatter `status:` field, and appends a JSONL entry to <data-dir>/sends.jsonl. Rejects repeat calls that would overwrite a terminal status with a different one; idempotent for repeat calls with the same `(draft_id, status, content_hash)` triple. Required for the calibration loop to track send hit-rate.',
    inputSchema: RecordSendOutcomeArgs,
    outputSchema: RecordSendOutcomeResult,
    handler: async ({ input }) => {
      // 1. Read + parse the draft.
      let draftContent: string;
      try {
        draftContent = await readImpl(input.draft_path);
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'record_send_outcome',
            undefined,
            `failed to read draft at ${input.draft_path}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      const parsedDraft = parseFrontmatter({ input: draftContent });
      if (parsedDraft === null) {
        return err(
          McpErrors.unexpected(
            'record_send_outcome',
            undefined,
            `draft at ${input.draft_path} has no parseable YAML frontmatter — refusing to record outcome against a draft that prepare_send could not have produced`,
          ),
        );
      }

      // 2. Validate the draft hasn't drifted since prepare_send.
      const draftIdOnDisk = parsedDraft.frontmatter['draft_id'];
      if (draftIdOnDisk !== input.draft_id) {
        return err(
          McpErrors.unexpected(
            'record_send_outcome',
            undefined,
            `draft_id mismatch — input \`${input.draft_id}\`, on-disk \`${draftIdOnDisk ?? '(missing)'}\`. The draft was either edited or replaced between prepare_send and record_send_outcome; re-run prepare_send to refresh.`,
          ),
        );
      }
      const hashOnDisk = hashContent({ frontmatter: parsedDraft.frontmatter, body: parsedDraft.body });
      if (hashOnDisk !== input.content_hash) {
        return err(
          McpErrors.unexpected(
            'record_send_outcome',
            undefined,
            `content_hash mismatch — input \`${input.content_hash}\`, on-disk \`${hashOnDisk}\`. The draft (frontmatter or body) was edited between prepare_send and record_send_outcome; re-run prepare_send to refresh.`,
          ),
        );
      }

      // 3. Reject conflicting terminal-status overwrites.
      const existingStatus = parsedDraft.frontmatter['status'];
      if (existingStatus != null && TERMINAL_STATUSES.has(existingStatus) && existingStatus !== input.status) {
        return err(
          McpErrors.unexpected(
            'record_send_outcome',
            undefined,
            `draft at ${input.draft_path} already has terminal status \`${existingStatus}\`; refusing to overwrite with \`${input.status}\`. record_send_outcome is meant to be called once per send attempt.`,
          ),
        );
      }

      // 4. Resolve the JSONL log path.
      const resolved =
        logPathOverride != null ? ok(logPathOverride) : resolveDataDir().map((dir) => join(dir, SENDS_LOG_FILENAME));
      if (resolved.isErr()) {
        return err(McpErrors.unexpected('record_send_outcome', undefined, resolved.error.message));
      }
      const logPath = resolved.value;

      // 5. Atomically rewrite the draft with the new status. Write to a
      // sibling temp file and rename — `rename` is atomic on the same
      // filesystem, so a crash mid-write can't leave a half-written draft.
      const updatedFrontmatter: Record<string, string> = { ...parsedDraft.frontmatter, status: input.status };
      const updatedDraft = serializeDraft({ frontmatter: updatedFrontmatter, body: parsedDraft.body });
      const tempDraftPath = `${input.draft_path}.tmp-${now()}`;
      try {
        await writeImpl(tempDraftPath, updatedDraft);
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'record_send_outcome',
            undefined,
            `failed to write temp draft ${tempDraftPath}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }
      try {
        await renameFn(tempDraftPath, input.draft_path);
      } catch (e) {
        return err(
          McpErrors.unexpected(
            'record_send_outcome',
            undefined,
            `failed to atomically rename ${tempDraftPath} -> ${input.draft_path}: ${e instanceof Error ? e.message : String(e)}`,
          ),
        );
      }

      // 6. Read existing log, check idempotency, append the new JSONL entry.
      //
      // Idempotency: if a row already exists with the same
      // (draft_id, status, content_hash) triple, return that row's
      // line_number instead of writing a new row. Without this, a
      // retry after transport ambiguity (the model never saw the
      // tool's response and called record_send_outcome a second time)
      // would double-count the outcome in the calibration log.
      let prevContent = '';
      try {
        prevContent = await readImpl(logPath);
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
      const existingLines = prevContent.length === 0 ? [] : prevContent.split('\n').filter((l) => l.trim().length > 0);
      const duplicateLineNumber = findIdempotentMatch({
        lines: existingLines,
        draftId: input.draft_id,
        status: input.status,
        contentHash: input.content_hash,
      });
      if (duplicateLineNumber != null) {
        return ok({
          log_path: logPath,
          line_number: duplicateLineNumber,
          draft_status: input.status,
        });
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

      const line: Record<string, unknown> = {
        ts: new Date(now()).toISOString(),
        draft_path: input.draft_path,
        draft_id: input.draft_id,
        content_hash: input.content_hash,
        status: input.status,
      };
      if (input.status === 'sent') line['sent_url'] = input.sent_url;
      if (input.status === 'failed') line['error'] = input.error;
      const encoded = `${JSON.stringify(line)}\n`;

      let next = encoded;
      try {
        const existing = await stat(logPath);
        if (existing.isFile()) {
          next =
            prevContent.endsWith('\n') || prevContent.length === 0
              ? `${prevContent}${encoded}`
              : `${prevContent}\n${encoded}`;
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
        await writeImpl(logPath, next);
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
        line_number: existingLines.length + 1,
        draft_status: input.status,
      });
    },
  });
}

/**
 * Scan the existing JSONL log for a row matching
 * `(draft_id, status, content_hash)`. Returns the 1-based line number
 * of the first match (or `null` if no match). Malformed lines are
 * skipped — a corrupted historical row should never block a new
 * append. Used to make `record_send_outcome` idempotent across
 * retries.
 */
function findIdempotentMatch({
  lines,
  draftId,
  status,
  contentHash,
}: {
  lines: readonly string[];
  draftId: string;
  status: string;
  contentHash: string;
}): number | null {
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw == null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const row = parsed as Record<string, unknown>;
    if (row['draft_id'] === draftId && row['status'] === status && row['content_hash'] === contentHash) {
      return i + 1;
    }
  }
  return null;
}
