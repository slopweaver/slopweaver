/**
 * Voice-rules domain errors. Pure-function module, but the parser can
 * still surface structural problems with the rules markdown (e.g. an
 * unrecognized rule directive) — those flow back as typed Results.
 */

import type { BaseError } from '@slopweaver/errors';

export interface VoiceRulesParseFailedError extends BaseError {
  readonly code: 'VOICE_RULES_PARSE_FAILED';
  readonly line: number;
  readonly raw: string;
}

// Unknown-directive lines used to be an error, but the parser now
// treats anything that isn't a known directive prefix as prose and
// silently skips it (so users can write commentary alongside their
// rules). A future directive expansion may resurrect the error type.
export type VoiceRulesError = VoiceRulesParseFailedError;

export const VoiceRulesErrors = {
  parseFailed: ({ line, raw }: { line: number; raw: string }): VoiceRulesParseFailedError => ({
    code: 'VOICE_RULES_PARSE_FAILED',
    message: `Could not parse rule at line ${line}: ${raw}`,
    line,
    raw,
  }),
} as const;
