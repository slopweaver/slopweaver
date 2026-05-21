export { appendDirectives, type AppendResult } from './append.ts';
export { formatDirective } from './format.ts';
export {
  parseFlagsToDirectives,
  runAddVoiceRule,
  type AddVoiceRuleFlags,
  type AddVoiceRuleIo,
} from './cli-action.ts';
export type { ForbidDirective, PatternDirective, ReplaceDirective, VoiceDirective } from './types.ts';
