/**
 * `start_retro` — returns the instructional body the model follows
 * to run a weekly retro. Tool-only design: the prompt is delivered
 * as the tool's structured output so the model can follow it inline
 * without needing a separate prompt-registry surface.
 */

import { StartRetroArgs, StartRetroResult } from '@slopweaver/contracts';
import { ok } from '@slopweaver/errors';
import { defineTool, type Tool } from '../../registry.ts';
import { RETRO_INSTRUCTIONS } from './instructions.ts';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type CreateStartRetroToolArgs = {
  now?: () => number;
  generateRetroId?: (nowMs: number) => string;
};

export function createStartRetroTool(args: CreateStartRetroToolArgs = {}): Tool {
  const now = args.now ?? Date.now;
  const generateRetroId = args.generateRetroId ?? defaultGenerator;

  return defineTool({
    name: 'start_retro',
    description:
      'Returns the instructional body for a weekly retro over the last 7 days of activity: pull evidence via catch_me_up + search_work_context, identify shifts in priorities/stakeholders/open loops, and propose 1-2 follow-ups. Returns the retro inline; only persists if work-console write tools are present. Designed for a Sunday-evening run.',
    inputSchema: StartRetroArgs,
    outputSchema: StartRetroResult,
    handler: async ({ input }) => {
      const nowMs = now();
      const sinceMs = input.since != null ? Date.parse(`${input.since}T00:00:00Z`) : nowMs - SEVEN_DAYS_MS;
      const since = formatDate(new Date(sinceMs));
      return ok({
        retro_id: generateRetroId(nowMs),
        since,
        instructions: RETRO_INSTRUCTIONS,
        generated_at: new Date(nowMs).toISOString(),
      });
    },
  });
}

function defaultGenerator(nowMs: number): string {
  const datePart = formatDate(new Date(nowMs)).replaceAll('-', '');
  const randomPart = Math.random().toString(36).slice(2, 8);
  return `retro_${datePart}_${randomPart}`;
}

function formatDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}
