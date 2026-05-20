/**
 * `start_retro` — returns the instructional body the model follows
 * to run a weekly retro. Tool-only design (same pattern as
 * `start_mega_audit`) so this PR is independent of #54's prompt
 * registry.
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
      'Returns the instructional body for a weekly retro: snapshot the current profile, diff against last week, re-aggregate /lock-in calibration, propose 1-2 /style-edit candidates from friction-tag spikes. Designed for a Sunday-evening run.',
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
