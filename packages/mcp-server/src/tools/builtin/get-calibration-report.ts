/**
 * `get_calibration_report` MCP tool. Read-side aggregator over the
 * walk-feedback JSONL. Counts outcomes by class, computes acceptance /
 * edit / rejection rates, surfaces the top friction tags. Used by the
 * `/calibration-report` slash command.
 *
 * Missing log → all zeros (not an error). The window defaults to the
 * last 30 days; callers can override with `since`.
 */

import { GetCalibrationReportArgs, GetCalibrationReportResult } from '@slopweaver/contracts';
import { err, ok } from '@slopweaver/errors';
import { McpErrors } from '../../errors.ts';
import { resolveWorkConsoleConfig, type WorkConsoleConfig } from '../../work-console/config.ts';
import { loadAndSummarize } from '../../work-console/feedback.ts';
import { feedbackLogPath } from '../../work-console/paths.ts';
import { defineTool, type Tool } from '../registry.ts';

export type CreateGetCalibrationReportToolArgs = {
  config?: WorkConsoleConfig;
  now?: () => Date;
};

export function createGetCalibrationReportTool(args: CreateGetCalibrationReportToolArgs = {}): Tool {
  const config = args.config ?? resolveWorkConsoleConfig();
  const now = args.now ?? (() => new Date());

  return defineTool({
    name: 'get_calibration_report',
    description:
      'Aggregates the walk-feedback JSONL into a calibration report (acceptance / edit / rejection rates, top friction tags). Missing log → all zeros.',
    inputSchema: GetCalibrationReportArgs,
    outputSchema: GetCalibrationReportResult,
    handler: async ({ input }) => {
      const absLogPath = feedbackLogPath(config);
      const result = await loadAndSummarize({
        absLogPath,
        ...(input.since !== undefined && { sinceIso: input.since }),
        now,
      });
      if (result.isErr()) {
        return err(McpErrors.unexpected('get_calibration_report', undefined, result.error.message));
      }
      const s = result.value;
      return ok({
        window_start: s.windowStartIso,
        window_end: s.windowEndIso,
        total_walks: s.totalWalks,
        total_items: s.totalItems,
        outcome_counts: s.outcomeCounts,
        acceptance_rate: s.acceptanceRate,
        edit_rate: s.editRate,
        rejection_rate: s.rejectionRate,
        top_friction_tags: s.topFrictionTags.map((t) => ({ tag: t.tag, count: t.count })),
        generated_at: now().toISOString(),
      });
    },
  });
}
