/**
 * `log_walk_feedback` MCP tool. Appends one walk-feedback line to the
 * configured JSONL log. Schema mirrors the `/lock-in` walk-feedback shape
 * from ev-admin. Used silently by the `/lock-in` prompt after each item
 * resolution to build the substrate for `/calibration-report`.
 */

import { LogWalkFeedbackArgs, LogWalkFeedbackResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { appendFeedbackLine, type WalkFeedbackLine } from '../../work-console/feedback.ts';
import { feedbackLogPath } from '../../work-console/paths.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateLogWalkFeedbackToolArgs = {
  config?: WorkConsoleConfig;
  now?: () => Date;
};

export function createLogWalkFeedbackTool(args: CreateLogWalkFeedbackToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();
  const now = args.now ?? (() => new Date());

  return defineTool({
    name: 'log_walk_feedback',
    description:
      'Append one walk-feedback line to the configured JSONL log. Called silently by /lock-in after each item resolution. Returns the absolute log path + 1-based line number.',
    inputSchema: LogWalkFeedbackArgs,
    outputSchema: LogWalkFeedbackResult,
    handler: async ({ input }) => {
      const absLogPath = feedbackLogPath(config);
      const linePayload: Omit<WalkFeedbackLine, 'ts'> = {
        walk_id: input.walk_id,
        item_index: input.item_index,
        outcome: input.outcome,
        ...(input.item_anchor !== undefined && { item_anchor: input.item_anchor }),
        ...(input.item_source !== undefined && { item_source: input.item_source }),
        ...(input.item_summary !== undefined && { item_summary: input.item_summary }),
        ...(input.proposed_action !== undefined && { proposed_action: input.proposed_action }),
        ...(input.user_action !== undefined && { user_action: input.user_action }),
        ...(input.user_text !== undefined && { user_text: input.user_text }),
        ...(input.edit_diff !== undefined && { edit_diff: input.edit_diff }),
        ...(input.tags !== undefined && { tags: input.tags }),
        ...(input.totals !== undefined && { totals: input.totals }),
        ...(input.duration_minutes !== undefined && { duration_minutes: input.duration_minutes }),
      };
      const result = await appendFeedbackLine({
        absLogPath,
        line: linePayload,
        now,
      });
      if (result.isErr()) {
        return err(McpErrors.unexpected('log_walk_feedback', undefined, result.error.message));
      }
      return ok({
        log_path: result.value.absolutePath,
        line_number: result.value.lineNumber,
        bytes_appended: result.value.bytesAppended,
      });
    },
  });
}
