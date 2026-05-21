/**
 * @slopweaver/voice-rules — deterministic post-processor for drafts.
 *
 * Usage:
 *
 *   import { parseVoiceRules, applyVoiceRules } from '@slopweaver/voice-rules';
 *
 *   const parsed = parseVoiceRules(rulesMarkdown);
 *   if (parsed.isErr()) { ... }
 *   const { rewritten, edits } = applyVoiceRules(draftText, parsed.value);
 *
 * The two functions are pure: same inputs → same outputs, no I/O,
 * never throws. That contract is what makes this safe to run last-mile
 * before a `/lock-in` send (see #59 / #6) — a corrupted rules file can
 * never crash an outgoing reply.
 */

export { parseVoiceRules } from './parse.ts';
export { applyVoiceRules } from './apply.ts';
export type { Rule, ForbidTokenRule, ReplaceRule, DisallowPatternRule, Edit, ApplyResult } from './types.ts';
export type { VoiceRulesError } from './errors.ts';
export { VoiceRulesErrors } from './errors.ts';
